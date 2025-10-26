import './config/load-env.js';
import { randomUUID } from 'node:crypto';

import { createLogger } from './logging.js';
import { createSimpleWorker, SimpleQueueEvents, SimpleQueue } from './queues/simple-queue.js';
import { ensureRedis } from './redis/client.js';
import { query } from './db/index.js';
import { CircuitBreaker } from './lib/circuit-breaker.js';
import { normalizeWhatsappPhone } from './lib/phone.js';
import { runLandingTtlJob } from './jobs/landing-ttl.js';
import { runKpiRefreshJob } from './jobs/kpi-refresh.js';
import { invalidateDeliveryStatusCache } from './modules/delivery-status-cache.js';
import {
  buildTemplateVars,
  buildWhatsappComponentsFromVars,
  buildEmailContentFromTemplate,
} from './modules/delivery-templates.js';

const env = process.env;
const logger = createLogger({ env, service: env.SERVICE_NAME || 'workers' });

const whatsappQueueName =
  env.WHATSAPP_QUEUE_NAME || env.WA_OUTBOUND_QUEUE_NAME || env.DELIVERY_QUEUE_NAME || 'queue:whatsapp';
const emailQueueName = env.EMAIL_QUEUE_NAME || 'queue:email';
const pdfQueueName = env.PDF_QUEUE_NAME || 'queue:pdf';
const waInboundQueueName = env.WA_INBOUND_QUEUE_NAME || 'wa_inbound';
const paymentsQueueName = env.PAYMENTS_QUEUE_NAME || 'paymentsQueue';
const deliveryFailedQueueName = env.DELIVERY_FAILED_QUEUE_NAME || 'queue:delivery:failed';

const deliveryFailedQueue = new SimpleQueue(deliveryFailedQueueName, {
  logger,
  connectionOptions: { env, logger },
  defaultJobOptions: { attempts: 1, backoff: { type: 'fixed', delay: 0 }, removeOnComplete: false, removeOnFail: false },
});

const whatsappBreaker = new CircuitBreaker({
  failureThreshold: Number(env.WA_FAILURE_THRESHOLD || 3),
  resetTimeoutMs: Number(env.WA_RESET_TIMEOUT_MS || 60000),
});
const emailBreaker = new CircuitBreaker({
  failureThreshold: Number(env.EMAIL_FAILURE_THRESHOLD || 3),
  resetTimeoutMs: Number(env.EMAIL_RESET_TIMEOUT_MS || 60000),
});

async function main() {
  logger({
    level: 'info',
    message: 'worker_started',
    queues: [whatsappQueueName, emailQueueName, pdfQueueName, waInboundQueueName, paymentsQueueName, deliveryFailedQueueName],
  });

  await ensureRedis({ name: 'workers', env });

  await Promise.all([
    bootstrapOutboundWorker({ queueName: whatsappQueueName, channel: 'whatsapp' }),
    bootstrapOutboundWorker({ queueName: emailQueueName, channel: 'email' }),
    bootstrapWaInboundWorker(),
    bootstrapPaymentsWorker(),
  ]);

  scheduleLandingJob();
  scheduleKpiRefreshJob();

  const metricsDisabled =
    String(env.QUEUE_METRICS_DISABLED || '').toLowerCase() === 'true' || env.NODE_ENV === 'test';
  if (metricsDisabled) {
    logger({
      level: 'info',
      message: 'queue_metrics_disabled',
      reason: env.NODE_ENV === 'test' ? 'node_env_test' : 'flagged',
    });
  } else {
    scheduleQueueMetrics();
  }
}

async function bootstrapOutboundWorker({ queueName, channel }) {
  const worker = await createSimpleWorker(
    queueName,
    async (job) => {
      logger({
        level: 'info',
        message: 'delivery_job_processing',
        job_id: job.id,
        request_id: job.data.requestId,
        event_id: job.data.eventId,
        guest_id: job.data.guestId,
        attempt: job.attemptsMade + 1,
        queue: queueName,
        channel: channel || job.data.channel,
      });
      await processDeliveryJob(job, { queueName, channel });
    },
    {
      logger,
      connectionOptions: { env, logger },
      concurrency: Number(env.DELIVERY_WORKER_CONCURRENCY || 4),
      schedulerIntervalMs: Number(env.QUEUE_SCHEDULER_INTERVAL_MS || 1000),
    },
  );

  const events = new SimpleQueueEvents(queueName, { connectionOptions: { env, logger } });
  events.on('failed', ({ jobId, job }) => {
    logger({
      level: 'error',
      message: 'delivery_job_failed',
      job_id: jobId,
      request_id: job?.requestId,
      queue: queueName,
    });
  });
  events.on('dead-letter', ({ jobId, job }) => {
    logger({
      level: 'error',
      message: 'delivery_job_dead_letter',
      job_id: jobId,
      request_id: job?.requestId,
      queue: queueName,
    });
  });
  events.start();

  return worker;
}

async function bootstrapWaInboundWorker() {
  const worker = await createSimpleWorker(
    waInboundQueueName,
    async (job) => {
      logger({ level: 'info', message: 'wa_webhook_processing', job_id: job.id, webhook_id: job.data.webhookId });
      await processWaWebhook(job.data);
    },
    {
      logger,
      connectionOptions: { env, logger },
      concurrency: Number(env.WA_WEBHOOK_CONCURRENCY || 2),
      schedulerIntervalMs: Number(env.QUEUE_SCHEDULER_INTERVAL_MS || 1000),
    },
  );

  const events = new SimpleQueueEvents(waInboundQueueName, { connectionOptions: { env, logger } });
  events.on('failed', ({ jobId }) => {
    logger({ level: 'error', message: 'wa_webhook_failed', job_id: jobId });
  });
  events.on('dead-letter', ({ jobId }) => {
    logger({ level: 'error', message: 'wa_webhook_dead_letter', job_id: jobId });
  });
  events.start();

  return worker;
}

async function bootstrapPaymentsWorker() {
  const worker = await createSimpleWorker(
    paymentsQueueName,
    async (job) => {
      logger({ level: 'info', message: 'payments_webhook_processing', job_id: job.id, webhook_id: job.data.webhookId });
      await processPaymentsWebhook(job.data);
    },
    {
      logger,
      connectionOptions: { env, logger },
      concurrency: Number(env.PAYMENTS_WORKER_CONCURRENCY || 2),
      schedulerIntervalMs: Number(env.QUEUE_SCHEDULER_INTERVAL_MS || 1000),
    },
  );

  const events = new SimpleQueueEvents(paymentsQueueName, { connectionOptions: { env, logger } });
  events.on('failed', ({ jobId }) => {
    logger({ level: 'error', message: 'payments_webhook_failed', job_id: jobId });
  });
  events.on('dead-letter', ({ jobId }) => {
    logger({ level: 'error', message: 'payments_webhook_dead_letter', job_id: jobId });
  });
  events.start();

  return worker;
}

async function processDeliveryJob(job, options = {}) {
  const data = job?.data || {};
  const requestId = data.requestId;
  if (!requestId) {
    logger({ level: 'error', message: 'delivery_request_missing', job_id: job.id });
    return;
  }

  const requestResult = await query('SELECT * FROM delivery_requests WHERE id = $1', [requestId]);
  if (requestResult.rowCount === 0) {
    logger({ level: 'error', message: 'delivery_request_missing_in_db', request_id: requestId, job_id: job.id });
    return;
  }
  const request = requestResult.rows[0];

  const attempt = await beginDeliveryAttempt({
    requestId,
    metadata: data.metadata,
    isFree: Boolean(data.isFree),
    sessionId: data.sessionId || null,
  });
  if (!attempt) {
    logger({ level: 'error', message: 'delivery_attempt_not_created', request_id: requestId, job_id: job.id });
    return;
  }

  logger({
    level: 'info',
    message: 'delivery_attempt_started',
    request_id: requestId,
    attempt_id: attempt.attemptId,
    attempt: attempt.attemptNumber,
    job_id: job.id,
  });

  const guestId = data.guestId || request.guest_id;
  const channel = options.channel || data.channel || request.channel;
  const template = data.template || request.template;
  const basePayload = data.payload ?? request.payload ?? {};
  const payload = typeof basePayload === 'object' && basePayload !== null ? basePayload : {};

  const guestResult = await query('SELECT id, name, phone, email, event_id FROM guests WHERE id = $1', [guestId]);
  if (guestResult.rowCount === 0) {
    await failDeliveryAttempt({
      requestId,
      attemptId: attempt.attemptId,
      errorInfo: { error: 'guest_not_found' },
      willRetry: false,
    });
    throw new Error('guest_not_found');
  }

  const guest = guestResult.rows[0];
  const eventResult = await query('SELECT id, name, starts_at, ends_at FROM events WHERE id = $1', [request.event_id]);
  const event = eventResult.rows[0] || null;
  const templateVars = buildTemplateVars({ template, baseVars: payload.vars, guest, event });
  const whatsappPayload = {
    ...payload,
    vars: templateVars,
    components: buildWhatsappComponentsFromVars(template, templateVars),
  };
  const emailTemplate = buildEmailContentFromTemplate({ template, vars: templateVars, payload });
  const emailPayload = { ...payload, vars: templateVars, ...emailTemplate };

  let providerRef = null;
  let finalStatus = 'sent';

  try {
    if (channel === 'whatsapp') {
      const result = await sendWhatsAppMessage({ guest, template, payload: whatsappPayload });
      providerRef = result.providerRef;
      finalStatus = result.status || 'sent';
    } else {
      const result = await sendEmailMessage({ guest, template, payload: emailPayload });
      providerRef = result.providerRef;
      finalStatus = result.status || 'sent';
    }
  } catch (error) {
    logger({
      level: 'error',
      message: 'delivery_channel_failed',
      channel,
      guest_id: guestId,
      request_id: requestId,
      error: error.message,
    });
    const errorInfo = { channel, message: error.message };
    if (channel === 'whatsapp') {
      try {
        const result = await sendEmailMessage({ guest, template, payload: emailPayload });
        providerRef = result.providerRef;
        finalStatus = result.status || 'sent';
      } catch (fallbackError) {
        const willRetry = job.attemptsMade + 1 < Number(job.opts?.attempts || 1);
        await failDeliveryAttempt({
          requestId,
          attemptId: attempt.attemptId,
          errorInfo: { channel: 'email', message: fallbackError.message },
          willRetry,
        });
        logRetrySchedule({
          requestId,
          attempt: attempt.attemptNumber,
          willRetry,
          backoff: job.opts?.backoff,
          attemptsMade: job.attemptsMade + 1,
        });
        throw fallbackError;
      }
    } else {
      const willRetry = job.attemptsMade + 1 < Number(job.opts?.attempts || 1);
      await failDeliveryAttempt({
        requestId,
        attemptId: attempt.attemptId,
        errorInfo,
        willRetry,
      });
      logRetrySchedule({
        requestId,
        attempt: attempt.attemptNumber,
        willRetry,
        backoff: job.opts?.backoff,
        attemptsMade: job.attemptsMade + 1,
      });
      throw error;
    }
  }

  try {
    const completion = await completeDeliveryAttempt({
      requestId,
      attemptId: attempt.attemptId,
      status: finalStatus,
      providerRef,
      guestId,
    });

    logger({
      level: 'info',
      message: 'delivery_attempt_completed',
      request_id: requestId,
      attempt_id: attempt.attemptId,
      attempt: attempt.attemptNumber,
      status: completion.status,
      provider_ref: providerRef,
      channel,
    });
  } catch (error) {
    const willRetry = job.attemptsMade + 1 < Number(job.opts?.attempts || 1);
    await failDeliveryAttempt({
      requestId,
      attemptId: attempt.attemptId,
      errorInfo: { channel, message: error.message },
      willRetry,
    });
    logRetrySchedule({
      requestId,
      attempt: attempt.attemptNumber,
      willRetry,
      backoff: job.opts?.backoff,
      attemptsMade: job.attemptsMade + 1,
    });
    throw error;
  }
}

async function processWaWebhook(data) {
  const payload = data.payload || {};
  const contact = extractWhatsappContact(payload);
  if (!contact) {
    logger({ level: 'warn', message: 'wa_webhook_no_contact', webhook_id: data.webhookId });
    return;
  }

  const inboundMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const normalizedContact = normalizeWhatsappPhone(contact);
  const sessionPhone = normalizedContact || contact;
  const primaryMessage = inboundMessages.find((message) => typeof message?.id === 'string');
  const primaryMessageId = primaryMessage?.id || null;
  const expiresAt = new Date(Date.now() + Number(env.WA_SESSION_TTL_SECONDS || 24 * 3600) * 1000);
  const sessionResult = await query(
    `
      INSERT INTO wa_sessions (phone, started_at, expires_at, metadata, last_message_at, updated_at)
      VALUES (
        $1,
        now(),
        $2,
        jsonb_strip_nulls(jsonb_build_object(
          'last_webhook_id', $3,
          'last_message_id', $4,
          'raw_phone', $5
        )),
        now(),
        now()
      )
      ON CONFLICT (phone) DO UPDATE
        SET started_at = CASE
              WHEN wa_sessions.expires_at > now() THEN wa_sessions.started_at
              ELSE EXCLUDED.started_at
            END,
            expires_at = EXCLUDED.expires_at,
            metadata = jsonb_strip_nulls(wa_sessions.metadata || EXCLUDED.metadata),
            last_message_at = now(),
            updated_at = now()
      RETURNING id, started_at, expires_at
    `,
    [sessionPhone, expiresAt, data.webhookId, primaryMessageId, contact],
  );

  const sessionRow = sessionResult.rows[0] || null;
  const sessionId = sessionRow?.id || null;

  const redis = await ensureRedis({ name: 'wa-sessions', env });
  const ttlSeconds = Number(env.WA_SESSION_TTL_SECONDS || 24 * 3600);
  const cacheKeys = new Set([sessionPhone]);
  if (contact && contact !== sessionPhone) {
    cacheKeys.add(contact);
  }
  for (const key of cacheKeys) {
    await redis.set(`wa:session:${key}`, 'open', 'EX', ttlSeconds);
  }

  for (const message of inboundMessages) {
    const messageId = message?.id || message?.message_id || null;
    if (messageId) {
      const dedupeTtl = Number(env.WA_INBOUND_DEDUPE_TTL_SECONDS || 3 * 24 * 3600);
      const dedupeResult = await redis.set(`wa:inbound:${messageId}`, data.webhookId, 'NX', 'EX', dedupeTtl);
      if (dedupeResult !== 'OK') {
        continue;
      }
    }
    await handleInboundMessage({
      message,
      contact: sessionPhone,
      rawContact: contact,
      webhook: data,
      env,
      sessionId,
    });
  }

  const statusUpdates = Array.isArray(payload.statuses) ? payload.statuses : [];
  for (const status of statusUpdates) {
    if (!status?.id) continue;
    const providerRef = status.id;
    const deliveryStatus = mapWhatsappStatus(status.status);
    if (deliveryStatus) {
      await query(
        `UPDATE delivery_logs
            SET status = $1,
                completed_at = now()
          WHERE provider_ref = $2`,
        [deliveryStatus, providerRef],
      );
      await query(
        `UPDATE delivery_requests
            SET current_status = $1,
                last_provider_ref = $2,
                last_error = NULL,
                updated_at = now()
          WHERE id = (
            SELECT request_id
              FROM delivery_logs
             WHERE provider_ref = $2
             ORDER BY created_at DESC
             LIMIT 1
          )`,
        [deliveryStatus, providerRef],
      );
      await invalidateDeliveryStatusCache({ providerRef, env });
    }
  }
}

async function processPaymentsWebhook(data) {
  const { provider, payload } = data;
  const redis = await ensureRedis({ name: 'director-cache', env });
  if (provider === 'stripe') {
    await handleStripeWebhook(payload);
  } else if (provider === 'conekta') {
    await handleConektaWebhook(payload);
  } else {
    await handleMockWebhook(payload);
  }
  await redis.del('director:overview');
}

async function sendWhatsAppMessage({ guest, template, payload }) {
  if (!whatsappBreaker.canExecute()) {
    throw new Error('wa_circuit_open');
  }

  const apiKey = env.WA_API_TOKEN || env.WA_360DIALOG_API_KEY;
  const apiBase = env.WA_API_BASE ? env.WA_API_BASE.replace(/\/$/, '') : '';
  const apiUrl =
    env.WA_360DIALOG_API_URL ||
    (apiBase ? `${apiBase}/v1/messages` : 'https://waba.360dialog.io/v1/messages');

  if (!apiKey || apiKey.startsWith('local_')) {
    const hintedRef = typeof payload?.providerRef === 'string' ? payload.providerRef : null;
    whatsappBreaker.success();
    logger({ level: 'warn', message: 'wa_send_simulated', guest_id: guest.id, simulated: true });
    return { providerRef: hintedRef || `wa-sim-${randomUUID()}`, status: 'sent' };
  }

  const body = {
    to: guest.phone,
    type: 'template',
    template: {
      name: template,
      language: { code: 'es' },
      components: Array.isArray(payload?.components) ? payload.components : [],
    },
  };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    whatsappBreaker.failure();
    const errorText = await response.text();
    throw new Error(`wa_send_failed_${response.status}_${errorText}`);
  }

  whatsappBreaker.success();
  const payloadResponse = await response.json().catch(() => ({}));
  const providerRef = payloadResponse.messages?.[0]?.id || `wa-${randomUUID()}`;

  const redis = await ensureRedis({ name: 'wa-sessions', env });
  const normalizedPhone = normalizeWhatsappPhone(guest.phone);
  const sessionKeys = new Set([normalizedPhone || guest.phone]);
  if (guest.phone && normalizedPhone && normalizedPhone !== guest.phone) {
    sessionKeys.add(guest.phone);
  }
  for (const key of sessionKeys) {
    if (key) {
      await redis.set(`wa:session:${key}`, 'open', 'EX', Number(env.WA_SESSION_TTL_SECONDS || 24 * 3600));
    }
  }

  return { providerRef, status: 'sent' };
}

async function sendEmailMessage({ guest, template, payload }) {
  if (!emailBreaker.canExecute()) {
    throw new Error('email_circuit_open');
  }

  const apiKey = env.RESEND_API_KEY;
  const apiUrl = env.RESEND_API_URL || 'https://api.resend.com/emails';

  if (!apiKey || apiKey.startsWith('local_')) {
    const hintedRef = typeof payload?.providerRef === 'string' ? payload.providerRef : null;
    emailBreaker.success();
    logger({ level: 'warn', message: 'email_send_simulated', guest_id: guest.id });
    return { providerRef: hintedRef || `email-sim-${randomUUID()}`, status: 'sent' };
  }

  const body = {
    from: env.RESEND_FROM_EMAIL || 'noreply@monotickets.dev',
    to: guest.email,
    subject: payload?.subject || `Actualización de tu evento`,
    html: payload?.html || `<p>Template ${template} enviado.</p>`,
  };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    emailBreaker.failure();
    const errorText = await response.text();
    throw new Error(`email_send_failed_${response.status}_${errorText}`);
  }

  emailBreaker.success();
  const payloadResponse = await response.json().catch(() => ({}));
  return { providerRef: payloadResponse.id || `email-${randomUUID()}`, status: 'sent' };
}

async function beginDeliveryAttempt({ requestId, metadata, isFree = false, sessionId = null }) {
  const requestUpdate = await query(
    `
      UPDATE delivery_requests
         SET attempt_count = attempt_count + 1,
             current_status = 'processing',
             updated_at = now()
       WHERE id = $1
       RETURNING attempt_count
    `,
    [requestId],
  );
  if (requestUpdate.rowCount === 0) {
    return null;
  }
  const attemptNumber = requestUpdate.rows[0].attempt_count;
  const result = await query(
    `
      INSERT INTO delivery_logs (
        request_id,
        attempt,
        status,
        metadata,
        is_free,
        session_id,
        queued_at,
        started_at,
        created_at
      )
      VALUES ($1, $2, 'processing', $3::jsonb, $4, $5, now(), now(), now())
      RETURNING id
    `,
    [requestId, attemptNumber, metadata ? JSON.stringify(metadata) : null, isFree, sessionId],
  );
  return { attemptId: result.rows[0].id, attemptNumber };
}

async function completeDeliveryAttempt({ requestId, attemptId, status, providerRef, guestId }) {
  await query(
    `
      UPDATE delivery_logs
         SET status = $1,
             provider_ref = COALESCE($2, provider_ref),
             error = NULL,
             completed_at = now()
       WHERE id = $3
    `,
    [status, providerRef, attemptId],
  );

  if (providerRef) {
    try {
      await query(
        `
          INSERT INTO delivery_provider_refs (provider_ref, request_id, attempt_id, guest_id)
          VALUES ($1, $2, $3, $4)
        `,
        [providerRef, requestId, attemptId, guestId || null],
      );
    } catch (error) {
      if (error?.code === '23505') {
        await query(
          `
            UPDATE delivery_logs
               SET status = 'duplicate',
                   error = jsonb_build_object('duplicate', true)
             WHERE id = $1
          `,
          [attemptId],
        );
        await query(
          `
            UPDATE delivery_requests
               SET current_status = 'duplicate',
                   last_provider_ref = $1,
                   last_error = NULL,
                   updated_at = now()
            WHERE id = $2
          `,
          [providerRef, requestId],
        );
        return { status: 'duplicate' };
      }
      throw error;
    }
  }

  await query(
    `
      UPDATE delivery_requests
         SET current_status = $1,
             last_provider_ref = COALESCE($2, last_provider_ref),
             last_error = NULL,
             updated_at = now()
       WHERE id = $3
    `,
    [status, providerRef, requestId],
  );

  await invalidateDeliveryStatusCache({ requestId, providerRef, env });
  return { status };
}

async function failDeliveryAttempt({ requestId, attemptId, errorInfo, willRetry }) {
  await query(
    `
      UPDATE delivery_logs
         SET status = 'failed',
             error = $1::jsonb,
             completed_at = now()
       WHERE id = $2
    `,
    [JSON.stringify(errorInfo), attemptId],
  );
  await query(
    `
      UPDATE delivery_requests
         SET current_status = $1,
             last_error = $2::jsonb,
             updated_at = now()
       WHERE id = $3
    `,
    [willRetry ? 'retrying' : 'failed', JSON.stringify(errorInfo), requestId],
  );
  if (!willRetry) {
    try {
      await deliveryFailedQueue.add(
        'delivery-failed',
        {
          requestId,
          attemptId,
          error: errorInfo,
          failedAt: new Date().toISOString(),
        },
        { attempts: 1, removeOnComplete: false, removeOnFail: false },
      );
    } catch (error) {
      logger({ level: 'error', message: 'delivery_dlq_enqueue_failed', request_id: requestId, error: error.message });
    }
  }
  await invalidateDeliveryStatusCache({ requestId, env });
}

function logRetrySchedule({ requestId, attempt, willRetry, backoff, attemptsMade }) {
  if (!willRetry) {
    return;
  }
  const delayMs = calculateBackoffDelay(backoff, attemptsMade);
  logger({
    level: 'warn',
    message: 'delivery_retry_scheduled',
    request_id: requestId,
    attempt,
    next_delay_ms: delayMs,
  });
}

function calculateBackoffDelay(backoff, attempt) {
  if (!backoff) return 0;
  if (typeof backoff === 'number') return backoff * attempt;
  const type = (backoff.type || 'exponential').toLowerCase();
  const delay = Number(backoff.delay || 1000);
  if (type === 'fixed') {
    return delay;
  }
  return delay * 2 ** Math.max(0, attempt - 1);
}

function extractWhatsappContact(payload) {
  if (Array.isArray(payload.contacts) && payload.contacts[0]?.wa_id) {
    return payload.contacts[0].wa_id;
  }
  if (Array.isArray(payload.messages) && payload.messages[0]?.from) {
    return payload.messages[0].from;
  }
  if (payload?.from) {
    return payload.from;
  }
  return null;
}

function mapWhatsappStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'delivered';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

async function invalidateLandingCache(eventId, env) {
  if (!eventId) return;
  const redis = await ensureRedis({ name: 'landing-cache', env });
  await redis.del(`landing:${eventId}`, `landing:dashboard:${eventId}`);
}

async function handleStripeWebhook(payload = {}) {
  const eventType = payload.type || payload.event || '';
  const object = payload.data?.object || {};
  const providerRef = object.id || payload.data?.id || null;
  const paymentId = object.metadata?.payment_id || null;
  const status = normalizeStripeStatus(object.status || eventType);

  if (!providerRef && !paymentId) {
    logger({ level: 'warn', message: 'stripe_webhook_missing_reference' });
    return;
  }

  await query(
    `UPDATE payments
     SET status = $1,
         provider_ref = COALESCE($2, provider_ref),
         confirmed_at = CASE WHEN $1 IN ('succeeded', 'confirmed') THEN now() ELSE confirmed_at END,
         updated_at = now()
     WHERE provider_ref = COALESCE($2, provider_ref)
        OR metadata ->> 'payment_id' = COALESCE($3, metadata ->> 'payment_id')`,
    [status, providerRef, paymentId],
  );
}

async function handleConektaWebhook(payload = {}) {
  const data = payload.data?.object || payload.data || {};
  const providerRef = data.id || data.reference_id || null;
  const status = normalizeConektaStatus(data.status || payload.type || 'pending');
  await query(
    `UPDATE payments
     SET status = $1,
         provider_ref = COALESCE($2, provider_ref),
         confirmed_at = CASE WHEN $1 IN ('paid', 'succeeded', 'confirmed') THEN now() ELSE confirmed_at END,
         updated_at = now()
     WHERE provider_ref = COALESCE($2, provider_ref)`,
    [status, providerRef],
  );
}

async function handleMockWebhook(payload = {}) {
  const providerRef = payload.providerRef || payload.id || null;
  if (!providerRef) return;
  await query(
    `UPDATE payments SET status = 'succeeded', provider_ref = $1, confirmed_at = now(), updated_at = now() WHERE provider_ref = $1`,
    [providerRef],
  );
}

async function handleInboundMessage({ message = {}, contact, rawContact, webhook, env, sessionId }) {
  const text = extractMessageText(message);
  if (!isConfirmationMessage(text)) {
    return;
  }

  const searchPhones = [contact];
  if (rawContact && rawContact !== contact) {
    searchPhones.push(rawContact);
  }

  let guestResult = { rowCount: 0 };
  let matchedPhone = contact;
  for (const phone of searchPhones) {
    guestResult = await query(
      `SELECT id, status, event_id
         FROM guests
        WHERE phone = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [phone],
    );
    if (guestResult.rowCount > 0) {
      matchedPhone = phone;
      break;
    }
  }

  if (guestResult.rowCount === 0) {
    logger({ level: 'info', message: 'wa_inbound_guest_not_found', phone: contact, webhook_id: webhook.webhookId });
    return;
  }

  const guest = guestResult.rows[0];
  if (guest.status === 'pending') {
    await query(
      `UPDATE guests
          SET status = 'confirmed',
              confirmation_payload = jsonb_strip_nulls(jsonb_build_object(
                'source', 'whatsapp',
                'webhookId', $2,
                'messageId', $3,
                'receivedAt', $4,
                'sessionId', $5,
                'phone', $6,
                'rawPhone', $7,
                'messageText', $8
              ))
        WHERE id = $1`,
      [
        guest.id,
        webhook.webhookId,
        message.id || message.message_id || null,
        webhook.receivedAt || new Date().toISOString(),
        sessionId,
        matchedPhone,
        rawContact || null,
        text,
      ],
    );
    await invalidateLandingCache(guest.event_id, env);
    logger({
      level: 'info',
      message: 'guest_confirmed_from_wa',
      guest_id: guest.id,
      event_id: guest.event_id,
      session_id: sessionId || undefined,
    });
  }
}

function extractMessageText(message = {}) {
  if (typeof message.text === 'string') return message.text;
  if (typeof message.body === 'string') return message.body;
  if (typeof message?.text?.body === 'string') return message.text.body;
  if (Array.isArray(message.messages) && message.messages[0]?.text) {
    return message.messages[0].text;
  }
  return '';
}

const CONFIRMATION_PATTERNS = [
  /\bconfirm/,
  /\bsi\b/,
  /\basist/,
  /\bvoy\b/,
  /\balli\b/,
  /\bahi\b/,
  /\bpresente\b/,
  /\bcuenten? conmigo\b/,
  /\bestare\b/,
];

function normalizeMessageText(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isConfirmationMessage(text = '') {
  const normalized = normalizeMessageText(text);
  if (!normalized) {
    return false;
  }
  return CONFIRMATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeStripeStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'payment_intent.succeeded':
    case 'succeeded':
      return 'succeeded';
    case 'payment_intent.processing':
    case 'processing':
      return 'processing';
    case 'payment_intent.payment_failed':
    case 'requires_payment_method':
    case 'failed':
      return 'failed';
    default:
      return status || 'pending';
  }
}

function normalizeConektaStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'paid':
    case 'succeeded':
      return 'paid';
    case 'pending':
    case 'pre_authorized':
      return 'pending';
    case 'expired':
    case 'canceled':
    case 'failed':
      return 'failed';
    default:
      return status || 'pending';
  }
}

function scheduleLandingJob() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const force = args.has('--force');

  const execute = async () => {
    try {
      await runLandingTtlJob({ env, logger, dryRun, force });
    } catch (error) {
      logger({ level: 'error', message: 'landing_ttl_job_failed', error: error.message });
    }
  };

  if (force) {
    execute();
  }

  const now = new Date();
  const hour = Number(env.LANDING_JOB_HOUR || 3);
  const minute = Number(env.LANDING_JOB_MINUTE || 0);
  const nextRun = new Date(now);
  nextRun.setHours(hour, minute, 0, 0);
  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  const delay = nextRun.getTime() - now.getTime();
  setTimeout(() => {
    execute();
    setInterval(execute, 24 * 3600 * 1000).unref();
  }, delay).unref();
}

function scheduleKpiRefreshJob() {
  const intervalMinutes = Math.max(5, Number(env.KPI_REFRESH_INTERVAL_MINUTES || 30));
  const initialDelayMs = Number(env.KPI_REFRESH_INITIAL_DELAY_MS || 15000);
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const force = args.has('--force');

  const execute = async () => {
    try {
      await runKpiRefreshJob({ env, logger, dryRun, force });
    } catch (error) {
      logger({ level: 'error', message: 'kpi_refresh_job_failed', error: error.message });
    }
  };

  if (force) {
    execute();
  }

  setTimeout(() => {
    execute();
    setInterval(execute, intervalMinutes * 60 * 1000).unref();
  }, initialDelayMs).unref();
}

function scheduleQueueMetrics() {
  const interval = Number(env.QUEUE_METRICS_INTERVAL_MS || 30000);
  const trackedQueues = [
    { name: 'whatsapp', queue: new SimpleQueue(whatsappQueueName, { connectionOptions: { env, logger } }) },
    { name: 'email', queue: new SimpleQueue(emailQueueName, { connectionOptions: { env, logger } }) },
    { name: 'pdf', queue: new SimpleQueue(pdfQueueName, { connectionOptions: { env, logger } }) },
    { name: 'waInbound', queue: new SimpleQueue(waInboundQueueName, { connectionOptions: { env, logger } }) },
    { name: 'payments', queue: new SimpleQueue(paymentsQueueName, { connectionOptions: { env, logger } }) },
    { name: 'deliveryFailed', queue: deliveryFailedQueue },
  ];

  const logMetrics = async () => {
    try {
      const snapshot = await Promise.all(trackedQueues.map(({ name, queue }) => buildMetrics(queue, name)));
      logger({ level: 'info', message: 'queue_metrics', queues: snapshot });
    } catch (error) {
      logger({ level: 'error', message: 'queue_metrics_failed', error: error.message });
    }
  };

  setInterval(logMetrics, interval).unref();
}

async function buildMetrics(queue, name) {
  const completedCount = typeof queue.countCompleted === 'function' ? await queue.countCompleted() : 0;
  const failedCount = typeof queue.countFailed === 'function' ? await queue.countFailed() : 0;
  const deadLetterCount = typeof queue.countDeadLetter === 'function' ? await queue.countDeadLetter() : 0;
  return {
    name,
    waiting: await queue.countWaiting(),
    delayed: await queue.countDelayed(),
    active: await queue.countActive(),
    completed: completedCount,
    failed: failedCount,
    deadLetter: deadLetterCount,
  };
}

main().catch((error) => {
  logger({ level: 'fatal', message: 'worker_failed', error: error.message });
  process.exit(1);
});
