import { randomUUID } from 'node:crypto';

import { query } from '../db/index.js';
import { ensureRedis } from '../redis/client.js';
import { normalizePhone, normalizeWhatsappPhone } from '../lib/phone.js';
import { z } from '../lib/zod-lite.js';
import { buildValidationError } from '../lib/validation.js';
import { normalizeDeliveryPayload } from './delivery-templates.js';
import {
  cacheDeliveryStatus,
  getCachedDeliveryStatus,
  invalidateDeliveryStatusCache,
} from './delivery-status-cache.js';

const DEFAULT_CHANNEL = 'whatsapp';
const SUPPORTED_CHANNELS = new Set(['whatsapp', 'email', 'pdf']);
const DEFAULT_TEMPLATE = 'event_invitation';
const DEFAULT_ORGANIZER = '00000000-0000-0000-0000-000000000000';
const DEFAULT_DEDUPE_WINDOW_MINUTES = 1440;
const DEDUPE_PREFIX = 'delivery:dedupe';
const SIGNATURE_HEADER_KEYS = ['x-wa-signature', 'x-360dialog-signature', 'x-hub-signature'];

const stringIdentifier = z.string().trim().min(1);
const optionalStringIdentifier = stringIdentifier.optional();
const metadataSchema = z.record(z.any()).optional();

const guestReferenceSchema = z
  .object({
    id: optionalStringIdentifier,
    phone: z.string().trim().min(1).optional(),
    waId: z.string().trim().min(1).optional(),
  })
  .strip();

const deliverSendSchema = z
  .object({
    eventId: optionalStringIdentifier,
    event_id: optionalStringIdentifier,
    organizerId: optionalStringIdentifier,
    organizer_id: optionalStringIdentifier,
    channel: z.string().trim().min(1).optional(),
    template: z.string().trim().min(1).optional(),
    payload: z.record(z.any()).optional(),
    metadata: metadataSchema,
    guestIds: z.array(stringIdentifier).optional(),
    guests: z
      .array(z.union([stringIdentifier, guestReferenceSchema]))
      .optional(),
    guestId: optionalStringIdentifier,
    guest_id: optionalStringIdentifier,
    phone: z.string().trim().min(1).optional(),
    phones: z.array(z.string().trim().min(1)).optional(),
  })
  .strip();

const webhookBodySchema = z.object({}).strip();

const deliveryStatusSchema = z
  .object({
    deliveryId: z.string().trim().min(1).optional(),
    providerRef: z.string().trim().min(1).optional(),
  })
  .strip();

export function createDeliveryModule(options = {}) {
  const { env = process.env, queuesPromise, logger } = options;
  if (!queuesPromise) {
    throw new Error('queuesPromise is required for delivery module');
  }

  const log = logger || ((payload) => console.log(JSON.stringify(payload)));
  const dedupeWindowMinutes = Number(env.DELIVERY_DEDUPE_WINDOW_MIN || DEFAULT_DEDUPE_WINDOW_MINUTES);

  async function send({ body = {}, requestId }) {
    const parsed = deliverSendSchema.safeParse(body || {});
    if (!parsed.success) {
      return buildValidationError(parsed.error);
    }

    const normalizedBody = normalizeDeliveryRequestBody(parsed.data);

    const eventId = normalizeId(normalizedBody.eventId || normalizedBody.event_id);
    const organizerId = normalizeId(
      normalizedBody.organizerId || env.DEFAULT_ORGANIZER_ID || DEFAULT_ORGANIZER,
    );
    const channel = selectChannel(normalizedBody.channel);
    const template = typeof normalizedBody.template === 'string' ? normalizedBody.template : DEFAULT_TEMPLATE;
    const payload = normalizedBody.payload;

    if (!eventId) {
      return { statusCode: 400, payload: { error: 'event_id_required' } };
    }

    const targets = await resolveRecipients({ body: normalizedBody, eventId });

    if (targets.length === 0) {
      return { statusCode: 400, payload: { error: 'recipient_required' } };
    }

    const results = [];
    for (const target of targets) {
      if (target.error) {
        results.push({
          guestId: target.guestId,
          phone: target.phone,
          status: 'failed',
          error: target.error,
        });
        continue;
      }

      try {
        const result = await enqueueOutbound({
          eventId,
          guestId: target.guestId,
          phone: target.phone,
          organizerId,
          channel,
          template,
          payload,
          requestId,
          metadata: normalizedBody.metadata,
        });
        results.push({ ...result, phone: target.phone });
      } catch (error) {
        log({
          level: 'error',
          message: 'delivery_send_failed',
          error: error.message,
          event_id: eventId,
          guest_id: target.guestId,
          request_id: requestId,
        });
        results.push({ guestId: target.guestId, phone: target.phone, status: 'failed', error: 'enqueue_failed' });
      }
    }

    const queuedCount = results.filter((item) => item.status === 'queued').length;
    return {
      statusCode: queuedCount > 0 ? 202 : 200,
      payload: {
        status: queuedCount > 0 ? 'queued' : results[0]?.status || 'ok',
        deliveries: results,
      },
    };
  }

  async function enqueueLegacySend({ eventId, guestId, body = {}, requestId }) {
    const parsed = deliverSendSchema.safeParse(body || {});
    if (!parsed.success) {
      return buildValidationError(parsed.error);
    }

    const normalizedBody = normalizeDeliveryRequestBody(parsed.data);

    const organizerId = normalizeId(
      normalizedBody.organizerId || env.DEFAULT_ORGANIZER_ID || DEFAULT_ORGANIZER,
    );
    const channel = selectChannel(normalizedBody.channel);
    const template = typeof normalizedBody.template === 'string' ? normalizedBody.template : DEFAULT_TEMPLATE;
    const payload = normalizedBody.payload;

    const result = await enqueueOutbound({
      eventId,
      guestId,
      organizerId,
      channel,
      template,
      payload,
      requestId,
      metadata: normalizedBody.metadata,
    });

    return {
      statusCode: result.status === 'queued' ? 202 : 200,
      payload: {
        status: result.status,
        jobId: result.jobId,
        requestId: result.requestId,
        correlationId: result.correlationId,
        duplicateOf: result.duplicateOf,
      },
    };
  }

  async function enqueueOutbound({
    eventId,
    guestId,
    phone,
    organizerId,
    channel,
    template,
    payload,
    requestId,
    metadata,
  }) {
    const redis = await ensureRedis({ name: 'delivery-dedupe', env });
    const dedupeKey = buildDedupeKey({ eventId, guestId, phone, template });
    const dedupeValue = requestId || randomUUID();
    const dedupeTtlSeconds = Math.max(60, dedupeWindowMinutes * 60);

    const dedupeResult = await redis.set(dedupeKey, dedupeValue, 'NX', 'EX', dedupeTtlSeconds);
    if (dedupeResult !== 'OK') {
      const existing = await findRecentDeliveryRequest({
        eventId,
        guestId,
        template,
        windowMinutes: dedupeWindowMinutes,
      });
      log({
        level: 'info',
        message: 'delivery_deduped',
        event_id: eventId,
        guest_id: guestId,
        template,
        request_id: requestId,
        duplicate_of: existing?.id || null,
      });
      return {
        guestId,
        status: 'duplicate',
        duplicateOf: existing?.id || null,
      };
    }

    const sanitizedMetadata = sanitizeMetadata(metadata);
    const normalizedPayload = normalizeDeliveryPayload(payload);

    let sessionInfo = null;
    if (channel === 'whatsapp' && phone) {
      sessionInfo = await findActiveWhatsappSession(normalizeWhatsappPhone(phone));
    }
    const isFreeSession = Boolean(sessionInfo?.isOpen);
    const activeSessionId = isFreeSession ? sessionInfo?.id || null : null;

    const request = await createDeliveryRequest({
      organizerId,
      eventId,
      guestId,
      channel,
      template,
      payload: normalizedPayload,
      metadata: sanitizedMetadata,
      dedupeKey,
    });

    const queues = await queuesPromise;
    const outboundQueue = selectQueueForChannel({ queues, channel });
    const jobPayload = {
      requestId: request.id,
      eventId,
      guestId,
      phone,
      organizerId,
      channel,
      template,
      payload: normalizedPayload,
      metadata: sanitizedMetadata,
      requestIdHeader: requestId,
      isFree: isFreeSession,
      sessionId: activeSessionId,
    };

    const jobOptions = {
      attempts: Number(env.DELIVERY_MAX_RETRIES || 5),
      backoff: buildQueueBackoff(env),
      removeOnComplete: true,
      removeOnFail: false,
      jobId: `delivery:${guestId}:${template}:${Date.now()}`,
    };

    let job;
    try {
      job = await outboundQueue.add('send', jobPayload, jobOptions);
    } catch (error) {
      await redis.del(dedupeKey);
      log({
        level: 'error',
        message: 'delivery_enqueue_failed',
        error: error.message,
        event_id: eventId,
        guest_id: guestId,
        request_id: requestId,
      });
      await markRequestFailureOnEnqueue(request.id, error);
      throw error;
    }

    await recordJobQueued(
      request.id,
      job.id,
      {
        isFree: isFreeSession,
        sessionId: activeSessionId,
      },
      env,
    );

    log({
      level: 'info',
      message: 'delivery_enqueued',
      job_id: job.id,
      request_id: request.id,
      correlation_id: request.correlationId,
      channel,
      event_id: eventId,
      guest_id: guestId,
      template,
    });

    return {
      guestId,
      status: 'queued',
      jobId: job.id,
      requestId: request.id,
      correlationId: request.correlationId,
    };
  }

  async function enqueueWebhook({ body = {}, headers = {}, requestId }) {
    const parsed = webhookBodySchema.safeParse(body || {});
    if (!parsed.success) {
      return buildValidationError(parsed.error);
    }

    const normalizedBody = parsed.data;

    const secret = env.WA_WEBHOOK_SECRET;
    if (secret) {
      const signature = findSignatureHeader(headers);
      if (!signature || signature !== secret) {
        log({
          level: 'warn',
          message: 'wa_webhook_signature_invalid',
          request_id: requestId,
        });
        return { statusCode: 401, payload: { error: 'invalid_signature' } };
      }
    }

    const queues = await queuesPromise;
    const inboundQueue = queues.waInboundQueue;
    const jobPayload = {
      webhookId: randomUUID(),
      payload: normalizedBody,
      receivedAt: new Date().toISOString(),
      requestId,
    };

    const job = await inboundQueue.add('wa-webhook', jobPayload, {
      attempts: Number(env.DELIVERY_MAX_RETRIES || 5),
      backoff: { type: 'exponential', delay: Number(env.WA_WEBHOOK_BACKOFF_DELAY_MS || 2000) },
      removeOnComplete: true,
      removeOnFail: false,
    });

    log({
      level: 'info',
      message: 'wa_webhook_enqueued',
      job_id: job.id,
      request_id: requestId,
    });

    return {
      statusCode: 200,
      payload: { ok: true, jobId: job.id },
    };
  }

  async function getStatus({ deliveryId, providerRef }) {
    const parsed = deliveryStatusSchema.safeParse({ deliveryId, providerRef });
    if (!parsed.success) {
      return buildValidationError(parsed.error);
    }

    const normalizedDeliveryId = parsed.data.deliveryId || null;
    const normalizedProviderRef = parsed.data.providerRef || null;

    if (!normalizedDeliveryId && !normalizedProviderRef) {
      return { statusCode: 400, payload: { error: 'delivery_id_required' } };
    }

    const numericId = normalizedDeliveryId && /^\d+$/.test(normalizedDeliveryId) ? Number(normalizedDeliveryId) : null;
    const cacheLookup = await getCachedDeliveryStatus({
      requestId: numericId,
      providerRef: normalizedProviderRef,
      env,
    });
    if (cacheLookup.cached) {
      return { statusCode: 200, payload: cacheLookup.cached, headers: { 'x-cache': 'hit' } };
    }

    let summary;
    if (normalizedProviderRef) {
      summary = await findDeliverySummaryByProviderRef(normalizedProviderRef);
    }

    if (!summary && numericId) {
      summary = await findDeliverySummaryByRequestId(numericId);
      if (!summary) {
        summary = await findDeliveryAttemptById(numericId);
      }
    }

    if (!summary) {
      return { statusCode: 404, payload: { error: 'not_found' } };
    }

    await cacheDeliveryStatus({
      requestId: summary.requestId,
      providerRef: summary.latestAttempt?.providerRef || normalizedProviderRef,
      summary,
      env,
      ttlSeconds: Number(env.DELIVERY_STATUS_CACHE_TTL_SECONDS || 45),
    });

    return {
      statusCode: 200,
      payload: summary,
      headers: { 'x-cache': 'miss' },
    };
  }

  async function getSession({ phone }) {
    if (!phone) {
      return {
        statusCode: 400,
        payload: { error: 'phone_required' },
      };
    }
    const client = await ensureRedis({ name: 'wa-sessions', env });
    const normalizedPhone = normalizeWhatsappPhone(phone);
    const cacheKeys = [normalizedPhone, phone]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .filter((value, index, arr) => arr.indexOf(value) === index);

    for (const key of cacheKeys) {
      const ttlSeconds = await client.ttl(getSessionKey(key));
      if (ttlSeconds > 0) {
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
        return {
          statusCode: 200,
          payload: { phone: key, status: 'open', expiresAt, ttlSeconds },
        };
      }
    }

    const lookupKey = normalizedPhone || phone;
    let dbSession;
    try {
      dbSession = await query(
        'SELECT id, phone, started_at, expires_at FROM wa_sessions WHERE phone = $1',
        [lookupKey],
      );
    } catch (error) {
      log({
        level: 'error',
        message: 'wa_session_lookup_failed',
        error: error.message,
        phone: lookupKey,
      });
      return {
        statusCode: 503,
        payload: { phone: lookupKey, status: 'unknown', error: 'session_lookup_failed' },
      };
    }
    if (dbSession.rowCount === 0) {
      return {
        statusCode: 404,
        payload: { phone: lookupKey, status: 'closed' },
      };
    }

    const row = dbSession.rows[0];
    const now = new Date();
    const expiresAt = new Date(row.expires_at);
    const status = expiresAt > now ? 'open' : 'closed';

    if (status === 'open') {
      const ttl = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
      if (ttl > 0) {
        await client.set(getSessionKey(row.phone), 'open', 'EX', ttl);
      }
    }

    return {
      statusCode: 200,
      payload: {
        phone: row.phone,
        status,
        startedAt: row.started_at,
        expiresAt: row.expires_at,
        sessionId: row.id,
      },
    };
  }

  return {
    send,
    enqueueLegacySend,
    enqueueWebhook,
    getSession,
    getStatus,
  };
}

function selectChannel(channel) {
  if (typeof channel === 'string' && SUPPORTED_CHANNELS.has(channel)) {
    return channel;
  }
  return DEFAULT_CHANNEL;
}

function selectQueueForChannel({ queues, channel }) {
  if (!queues) {
    throw new Error('queues_not_initialized');
  }
  if (channel === 'email' && queues.emailQueue) {
    return queues.emailQueue;
  }
  if (channel === 'pdf' && queues.pdfQueue) {
    return queues.pdfQueue;
  }
  if (queues.whatsappQueue) {
    return queues.whatsappQueue;
  }
  if (queues.waOutboundQueue) {
    return queues.waOutboundQueue;
  }
  if (queues.deliveryQueue) {
    return queues.deliveryQueue;
  }
  throw new Error('delivery_queue_missing');
}

function normalizeDeliveryRequestBody(raw = {}) {
  const data = { ...raw };
  const eventId = typeof data.eventId === 'string' && data.eventId ? data.eventId : data.event_id;
  const organizerId = typeof data.organizerId === 'string' && data.organizerId ? data.organizerId : data.organizer_id;
  const guestList = Array.isArray(data.guests) ? data.guests.map((guest) => normalizeGuestEntry(guest)).filter(Boolean) : undefined;
  const guestIds = mergeUniqueStrings([
    ...(Array.isArray(data.guestIds) ? data.guestIds : []),
    data.guestId,
    data.guest_id,
  ]);
  const phones = mergeUniqueStrings([
    ...(Array.isArray(data.phones) ? data.phones : []),
    data.phone,
  ]);

  return {
    ...data,
    eventId: typeof eventId === 'string' ? eventId.trim() : undefined,
    event_id: typeof eventId === 'string' ? eventId.trim() : undefined,
    organizerId: typeof organizerId === 'string' ? organizerId.trim() : undefined,
    organizer_id: typeof organizerId === 'string' ? organizerId.trim() : undefined,
    guests: guestList,
    guestIds,
    guestId: guestIds[0],
    guest_id: guestIds[0],
    phones,
    phone: phones[0],
    payload:
      data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload) ? data.payload : {},
    metadata:
      data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata) ? data.metadata : {},
  };
}

function mergeUniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeGuestEntry(entry) {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed ? trimmed : null;
  }
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const normalized = {};
  if (typeof entry.id === 'string' && entry.id.trim()) {
    normalized.id = entry.id.trim();
  }
  if (typeof entry.phone === 'string' && entry.phone.trim()) {
    normalized.phone = entry.phone.trim();
  }
  if (typeof entry.waId === 'string' && entry.waId.trim()) {
    normalized.waId = entry.waId.trim();
  }
  if (Object.keys(normalized).length === 0) {
    return null;
  }
  return normalized;
}

function collectGuestIds(body) {
  if (Array.isArray(body.guestIds)) {
    return body.guestIds.filter((id) => typeof id === 'string').map((id) => id.trim()).filter(Boolean);
  }
  if (Array.isArray(body.guests)) {
    return body.guests
      .map((item) => (typeof item === 'string' ? item : item?.id))
      .filter((id) => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean);
  }
  if (typeof body.guestId === 'string' && body.guestId.trim()) {
    return [body.guestId.trim()];
  }
  if (typeof body.guest_id === 'string' && body.guest_id.trim()) {
    return [body.guest_id.trim()];
  }
  return [];
}

function collectPhones(body) {
  const phones = [];
  if (typeof body.phone === 'string') {
    phones.push(body.phone);
  }
  if (Array.isArray(body.phones)) {
    for (const value of body.phones) {
      if (typeof value === 'string') {
        phones.push(value);
      }
    }
  }
  if (Array.isArray(body.guests)) {
    for (const guest of body.guests) {
      const phone = typeof guest === 'string' ? null : guest?.phone || guest?.waId;
      if (typeof phone === 'string') {
        phones.push(phone);
      }
    }
  }
  return phones;
}

function normalizeId(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
}

function buildDedupeKey({ eventId, guestId, phone, template }) {
  const identifier = guestId || (phone ? `phone:${normalizePhone(phone)}` : 'unknown');
  return `${DEDUPE_PREFIX}:${eventId || 'unknown'}:${identifier}:${template}`;
}

async function createDeliveryRequest({
  organizerId,
  eventId,
  guestId,
  channel,
  template,
  payload,
  metadata,
  dedupeKey,
}) {
  const payloadJson = JSON.stringify(payload ?? {});
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  const result = await query(
    `
      INSERT INTO delivery_requests (
        organizer_id,
        event_id,
        guest_id,
        channel,
        template,
        payload,
        metadata,
        dedupe_key
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
      RETURNING id, correlation_id
    `,
    [organizerId, eventId, guestId, channel, template, payloadJson, metadataJson, dedupeKey],
  );
  return {
    id: result.rows[0].id,
    correlationId: result.rows[0].correlation_id,
  };
}

async function findActiveWhatsappSession(phone) {
  if (!phone) {
    return null;
  }

  try {
    const result = await query(
      `SELECT id, phone, started_at, expires_at FROM wa_sessions WHERE phone = $1`,
      [phone],
    );
    if (result.rowCount === 0) {
      return null;
    }
    const row = result.rows[0];
    const expiresAt = new Date(row.expires_at);
    const now = new Date();
    const isOpen = expiresAt > now;
    return {
      id: row.id,
      phone: row.phone,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      isOpen,
    };
  } catch (error) {
    log({
      level: 'error',
      message: 'wa_session_lookup_failed',
      error: error.message,
      phone,
    });
    return null;
  }
}

  async function recordJobQueued(requestId, jobId, { isFree = false, sessionId = null } = {}, env = process.env) {
    await query(
      `
        UPDATE delivery_requests
           SET last_job_id = $1,
               current_status = 'queued',
             updated_at = now()
       WHERE id = $2
    `,
    [jobId, requestId],
  );

  await query(
    `
      INSERT INTO delivery_logs (request_id, attempt, status, is_free, session_id, queued_at, created_at)
      SELECT $1, 0, 'queued', $2, $3, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM delivery_logs WHERE request_id = $1 AND attempt = 0
       )
    `,
    [requestId, isFree, sessionId],
  ).catch(() => {});
  await invalidateDeliveryStatusCache({ requestId, env });
}

async function resolveRecipients({ body = {}, eventId }) {
  const targets = [];
  const seen = new Set();
  const guestIds = collectGuestIds(body);
  for (const guestId of guestIds) {
    if (!guestId || seen.has(guestId)) {
      continue;
    }
    const lookup = await query(
      `SELECT id, phone FROM guests WHERE id = $1 AND event_id = $2 LIMIT 1`,
      [guestId, eventId],
    );
    if (lookup.rowCount === 0) {
      targets.push({ guestId, error: 'guest_not_found' });
      continue;
    }
    seen.add(guestId);
    const phone = lookup.rows[0].phone ? normalizePhone(lookup.rows[0].phone) : undefined;
    targets.push({ guestId, phone });
  }

  const phoneEntries = collectPhones(body);
  for (const rawPhone of phoneEntries) {
    const phone = normalizePhone(rawPhone);
    if (!phone) continue;
    const lookup = await query(
      `SELECT id FROM guests WHERE event_id = $1 AND phone = $2 ORDER BY created_at DESC LIMIT 1`,
      [eventId, phone],
    );
    if (lookup.rowCount === 0) {
      targets.push({ phone, error: 'guest_not_found' });
      continue;
    }
    const guestId = lookup.rows[0].id;
    if (seen.has(guestId)) {
      continue;
    }
    seen.add(guestId);
    targets.push({ guestId, phone });
  }

  return targets;
}

async function markRequestFailureOnEnqueue(requestId, error) {
  await query(
    `
      UPDATE delivery_requests
         SET current_status = 'failed',
             last_error = $1::jsonb,
             updated_at = now()
       WHERE id = $2
    `,
    [JSON.stringify({ message: error.message, stage: 'enqueue' }), requestId],
  );
}

async function findRecentDeliveryRequest({ eventId, guestId, template, windowMinutes }) {
  const interval = Math.max(1, Number(windowMinutes || DEFAULT_DEDUPE_WINDOW_MINUTES));
  const result = await query(
    `SELECT id, current_status
       FROM delivery_requests
      WHERE event_id = $1
        AND guest_id = $2
        AND template = $3
        AND created_at >= now() - ($4 || ' minutes')::interval
      ORDER BY created_at DESC
      LIMIT 1`,
    [eventId, guestId, template, interval],
  ).catch(() => ({ rowCount: 0 }));
  return result?.rows?.[0] || null;
}

async function findDeliverySummaryByRequestId(requestId) {
  const result = await query(
    `
      SELECT
        dr.*,
        latest.id AS attempt_id,
        latest.attempt AS attempt_number,
        latest.status AS attempt_status,
        latest.provider_ref AS attempt_provider_ref,
        latest.error AS attempt_error,
        latest.is_free AS attempt_is_free,
        latest.session_id AS attempt_session_id,
        latest.started_at AS attempt_started_at,
        latest.completed_at AS attempt_completed_at,
        latest.created_at AS attempt_created_at
      FROM delivery_requests dr
      LEFT JOIN LATERAL (
        SELECT *
          FROM delivery_logs
         WHERE request_id = dr.id
         ORDER BY attempt DESC
         LIMIT 1
      ) AS latest ON TRUE
      WHERE dr.id = $1
    `,
    [requestId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return mapDeliverySummary(row);
}

async function findDeliverySummaryByProviderRef(providerRef) {
  const result = await query(
    `
      SELECT
        dr.*,
        dl.id AS attempt_id,
        dl.attempt AS attempt_number,
        dl.status AS attempt_status,
        dl.provider_ref AS attempt_provider_ref,
        dl.error AS attempt_error,
        dl.is_free AS attempt_is_free,
        dl.session_id AS attempt_session_id,
        dl.started_at AS attempt_started_at,
        dl.completed_at AS attempt_completed_at,
        dl.created_at AS attempt_created_at
      FROM delivery_logs dl
      JOIN delivery_requests dr
        ON dr.id = dl.request_id
      WHERE dl.provider_ref = $1
      ORDER BY dl.created_at DESC
      LIMIT 1
    `,
    [providerRef],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapDeliverySummary(result.rows[0]);
}

async function findDeliveryAttemptById(attemptId) {
  const result = await query(
    `
      SELECT
        dr.*,
        dl.id AS attempt_id,
        dl.attempt AS attempt_number,
        dl.status AS attempt_status,
        dl.provider_ref AS attempt_provider_ref,
        dl.error AS attempt_error,
        dl.is_free AS attempt_is_free,
        dl.session_id AS attempt_session_id,
        dl.started_at AS attempt_started_at,
        dl.completed_at AS attempt_completed_at,
        dl.created_at AS attempt_created_at
      FROM delivery_logs dl
      JOIN delivery_requests dr
        ON dr.id = dl.request_id
      WHERE dl.id = $1
      LIMIT 1
    `,
    [attemptId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapDeliverySummary(result.rows[0]);
}

function mapDeliverySummary(row) {
  return {
    requestId: row.id,
    correlationId: row.correlation_id,
    eventId: row.event_id,
    guestId: row.guest_id,
    organizerId: row.organizer_id,
    channel: row.channel,
    template: row.template,
    currentStatus: row.current_status,
    attemptCount: row.attempt_count,
    lastProviderRef: row.last_provider_ref,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastJobId: row.last_job_id,
    latestAttempt: row.attempt_id
      ? {
          id: row.attempt_id,
          attempt: row.attempt_number,
          status: row.attempt_status,
          providerRef: row.attempt_provider_ref,
          error: row.attempt_error,
          isFree: row.attempt_is_free,
          sessionId: row.attempt_session_id,
          startedAt: row.attempt_started_at,
          completedAt: row.attempt_completed_at,
          createdAt: row.attempt_created_at,
        }
      : null,
  };
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(metadata));
  } catch {
    return null;
  }
}

function buildQueueBackoff(env = process.env) {
  const raw = String(env.DELIVERY_BACKOFF_SEQUENCE_MS || '1000,5000,20000,60000');
  const delays = raw
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (delays.length === 0) {
    return { type: 'exponential', delay: Number(env.QUEUE_BACKOFF_DELAY_MS || 5000) };
  }
  return { type: 'sequence', delays };
}

function getSessionKey(phone) {
  return `wa:session:${phone}`;
}

function findSignatureHeader(headers = {}) {
  const headerEntries = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]);
  for (const candidate of SIGNATURE_HEADER_KEYS) {
    const match = headerEntries.find(([key]) => key === candidate);
    if (!match) continue;
    const value = Array.isArray(match[1]) ? match[1][0] : match[1];
    if (typeof value === 'string') {
      return value.trim();
    }
  }
  return '';
}
