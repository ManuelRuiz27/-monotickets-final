#!/usr/bin/env node

/**
 * Placeholder E2E runner that validates critical HTTP flows against the running
 * stack. Se ejecuta dentro del contenedor `tests` y reemplaza la dependencia
 * externa `testsprite`, que aún no está disponible en npm.
 */

loadDotenv();

const { Client } = require('pg');

const backendCandidates = dedupe([
  process.env.BASE_URL_BACKEND,
  process.env.TEST_TARGET_API,
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://backend-api:8080',
  'http://backend:8080',
]);

const frontendCandidates = dedupe([
  process.env.BASE_URL_FRONTEND,
  process.env.TEST_TARGET_WEB,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://frontend:3000',
  'http://frontend:3001',
]);

const dashboardCandidates = dedupe([
  process.env.BASE_URL_DASHBOARD,
  process.env.DASHBOARD_URL,
  'http://localhost:3100',
  'http://127.0.0.1:3100',
  'http://dashboard:3100',
]);

const databaseCandidates = dedupe([
  process.env.TEST_DB_HOST,
  process.env.DB_HOST,
  process.env.PGHOST,
  'localhost',
  '127.0.0.1',
  'database',
  'backend-db',
]);

let cachedBackendBase;
let cachedFrontendBase;
let cachedDashboardBase;
let cachedDbConfig;

const args = process.argv.slice(2);
const selectedTags = collectTags(args);

async function main() {
  const tasks = [];
  const runAll = selectedTags.length === 0;

  if (runAll || selectedTags.includes('@health')) {
    tasks.push(runHealthSuite());
  }

  if (runAll || selectedTags.includes('@confirm') || selectedTags.includes('@guests')) {
    tasks.push(runGuestFlow({ includeCreation: runAll || selectedTags.includes('@guests') }));
  }

  if (runAll || selectedTags.includes('@scan')) {
    tasks.push(runScanFlow());
  }

  if (runAll || selectedTags.includes('@wa')) {
    tasks.push(runWhatsappWebhook());
  }

  if (runAll || selectedTags.includes('@dashboards')) {
    tasks.push(runDashboardSuite());
  }

  if (runAll || selectedTags.includes('@queues')) {
    tasks.push(runQueueInstrumentationCheck());
  }

  if (runAll || selectedTags.includes('@wa-metrics') || selectedTags.includes('@data')) {
    tasks.push(runWhatsappDataChecks());
  }

  if (tasks.length === 0) {
    tasks.push(runSmokeChecks());
  }

  const results = await Promise.allSettled(tasks);
  const failures = results.filter(({ status }) => status === 'rejected');

  if (failures.length > 0) {
    failures.forEach(({ reason }) => {
      log({ level: 'error', message: reason?.message || String(reason) });
    });
    process.exit(1);
  }

  log({ level: 'info', message: 'e2e_checks_completed', tags: selectedTags.length ? selectedTags : ['@all'] });
}

function collectTags(argv) {
  const tags = [];
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '-t' || current === '--tag') {
      const next = argv[i + 1];
      if (next) {
        tags.push(next);
        i += 1;
      }
    } else if (current.startsWith('@')) {
      tags.push(current);
    }
  }
  return [...new Set(tags)];
}

async function runSmokeChecks() {
  await Promise.all([checkBackendHealth(), checkFrontendHome()]);
  log({ level: 'info', message: 'smoke_checks_ok' });
}

async function runDashboardSuite() {
  const dashboardBase = await resolveDashboardBase();
  const response = await timedFetch(dashboardBase);
  if (!response.ok) {
    throw new Error(`Dashboard home failed with status ${response.status}`);
  }
  const body = await response.text().catch(() => '');
  if (!body || !/<html/i.test(body)) {
    throw new Error('Dashboard response did not contain HTML payload');
  }
  log({ level: 'info', message: 'dashboard_home_ok', url: dashboardBase });
}

async function runHealthSuite() {
  await Promise.all([checkBackendHealth(), checkFrontendHealth()]);
  log({ level: 'info', message: 'health_checks_ok' });
}

async function runGuestFlow({ includeCreation = false } = {}) {
  await runSmokeChecks();
  const backendBase = await resolveBackendBase();
  const eventId = process.env.E2E_EVENT_ID || 'demo-event';
  const url = buildUrl(backendBase, `/events/${encodeURIComponent(eventId)}/guests`);
  const response = await timedFetch(url);
  if (!response.ok) {
    throw new Error(`Guest endpoint failed with status ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.guests)) {
    throw new Error('Guest endpoint responded without guests array');
  }

  const baseline = payload.guests.length;
  log({ level: 'info', message: 'guest_flow_ok', event_id: eventId, guests: baseline });

  if (includeCreation) {
    await createGuest({ backendBase, eventId, baseline });
  }
}

async function createGuest({ backendBase, eventId, baseline }) {
  const payload = {
    name: `Auto Guest ${Date.now()}`,
    email: `autoguest-${Date.now()}@example.com`,
    phone: `555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
    status: 'pending',
  };

  const createResponse = await timedFetch(buildUrl(backendBase, `/events/${encodeURIComponent(eventId)}/guests`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-source': 'e2e-runner' },
    body: JSON.stringify(payload),
  });

  const status = createResponse.status;
  if (status >= 200 && status < 300) {
    log({ level: 'info', message: 'guest_created', event_id: eventId, status });
    const followUp = await timedFetch(buildUrl(backendBase, `/events/${encodeURIComponent(eventId)}/guests`));
    if (followUp.ok) {
      const body = await followUp.json().catch(() => ({ guests: [] }));
      const total = Array.isArray(body.guests) ? body.guests.length : baseline;
      log({ level: 'info', message: 'guest_list_updated', guests: total, baseline });
    }
    return;
  }

  if (status >= 400 && status < 500) {
    const errorPayload = await createResponse.json().catch(() => ({ status }));
    log({ level: 'warn', message: 'guest_create_validation_error', status, payload: errorPayload });
    return;
  }

  throw new Error(`Guest creation returned unexpected status ${status}`);
}

async function runScanFlow() {
  await runSmokeChecks();
  const backendBase = await resolveBackendBase();
  const sample = {
    code: process.env.E2E_SAMPLE_CODE || 'MONO-123-ABC',
    eventId: process.env.E2E_EVENT_ID || 'demo-event',
  };
  const response = await timedFetch(buildUrl(backendBase, '/scan/validate'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sample),
  });
  if (!response.ok) {
    throw new Error(`Scan endpoint failed with status ${response.status}`);
  }
  const payload = await response.json();
  const allowedStatuses = new Set(['valid', 'duplicate', 'invalid']);
  if (!allowedStatuses.has(payload.status)) {
    throw new Error(`Unexpected scan status: ${payload.status}`);
  }
  log({ level: 'info', message: 'scan_flow_ok', status: payload.status });
}

async function runWhatsappWebhook() {
  const backendBase = await resolveBackendBase().catch(() => null);
  const candidates = dedupe([
    process.env.WA_WEBHOOK_URL,
    backendBase ? buildUrl(backendBase, '/wa/webhook') : null,
    'http://localhost:8080/wa/webhook',
    'http://127.0.0.1:8080/wa/webhook',
    'http://backend-api:8080/wa/webhook',
    'http://backend:8080/wa/webhook',
  ]);

  if (candidates.length === 0) {
    throw new Error('WA webhook endpoint not defined');
  }

  const payload = { type: 'ping', at: new Date().toISOString() };
  let lastError;

  for (const endpoint of candidates) {
    try {
      const response = await timedFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        lastError = new Error(`WA webhook failed with status ${response.status} (${endpoint})`);
        continue;
      }
      log({ level: 'info', message: 'wa_webhook_ok', endpoint });
      return;
    } catch (error) {
      lastError = new Error(`Fetch error for ${endpoint}: ${error.message}`);
    }
  }

  throw lastError || new Error('WA webhook checks failed');
}

async function runQueueInstrumentationCheck() {
  const backendBase = await resolveBackendBase();
  const response = await timedFetch(buildUrl(backendBase, '/metrics'));
  if (!response.ok) {
    throw new Error(`Metrics endpoint failed with status ${response.status}`);
  }
  const body = await response.text();
  const requiredQueues = ['wa_outbound', 'wa_inbound', 'payments'];
  const missing = requiredQueues.filter((queue) => !body.includes(`queue_backlog{queue="${queue}"}`));
  if (missing.length > 0) {
    throw new Error(`Missing queue backlog metrics for: ${missing.join(', ')}`);
  }
  log({ level: 'info', message: 'queue_metrics_ok', queues: requiredQueues });
}

async function runWhatsappDataChecks() {
  const ratio = await validateWhatsappFreeRatio();
  const session = await validateWhatsappSession();
  const partitions = await validateLogPartitions();
  log({
    level: 'info',
    message: 'wa_data_checks_ok',
    event_id: ratio.eventId,
    ratio: ratio.value,
    free_wa: ratio.freeWa,
    total_wa: ratio.totalWa,
    day: ratio.day,
    session_phone: session.phone,
    session_status: session.status,
    partitions,
  });
}

async function checkBackendHealth() {
  const backendBase = await resolveBackendBase();
  const response = await timedFetch(buildUrl(backendBase, '/health'));
  if (!response.ok) {
    throw new Error(`Backend health failed with status ${response.status}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!payload || payload.status !== 'ok') {
    throw new Error('Backend health payload invalid');
  }
  log({ level: 'info', message: 'backend_health_ok', env: payload.env });
}

async function checkFrontendHome() {
  const frontendBase = await resolveFrontendBase();
  const response = await timedFetch(frontendBase);
  if (!response.ok) {
    throw new Error(`Frontend home failed with status ${response.status}`);
  }
  log({ level: 'info', message: 'frontend_home_ok' });
}

async function checkFrontendHealth() {
  const frontendBase = await resolveFrontendBase();
  const response = await timedFetch(buildUrl(frontendBase, '/health'));
  if (!response.ok) {
    throw new Error(`Frontend health failed with status ${response.status}`);
  }
  log({ level: 'info', message: 'frontend_health_ok' });
}

async function resolveBackendBase() {
  if (cachedBackendBase) {
    return cachedBackendBase;
  }
  cachedBackendBase = await resolveService('backend', backendCandidates, '/health');
  log({ level: 'debug', message: 'backend_base_resolved', url: cachedBackendBase });
  return cachedBackendBase;
}

async function resolveFrontendBase() {
  if (cachedFrontendBase) {
    return cachedFrontendBase;
  }
  cachedFrontendBase = await resolveService('frontend', frontendCandidates, '/');
  log({ level: 'debug', message: 'frontend_base_resolved', url: cachedFrontendBase });
  return cachedFrontendBase;
}

async function resolveDashboardBase() {
  if (cachedDashboardBase) {
    return cachedDashboardBase;
  }
  cachedDashboardBase = await resolveService('dashboard', dashboardCandidates, '/');
  log({ level: 'debug', message: 'dashboard_base_resolved', url: cachedDashboardBase });
  return cachedDashboardBase;
}

async function resolveService(name, candidates, probePath) {
  const attempts = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const base = normalizeBase(candidate);
    try {
      const target = probePath ? buildUrl(base, probePath) : base;
      const response = await timedFetch(target);
      if (!response.ok) {
        attempts.push(`${base} -> status ${response.status}`);
        continue;
      }
      return base;
    } catch (error) {
      attempts.push(`${base} -> ${error.message}`);
    }
  }
  throw new Error(`Unable to resolve ${name} endpoint. Attempts: ${attempts.join('; ')}`);
}

async function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeout());
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw new Error(`Fetch error for ${url}: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function getTimeout() {
  const raw = parseInt(process.env.TEST_TIMEOUT || '300000', 10);
  if (Number.isNaN(raw)) {
    return 300000;
  }
  return raw;
}

async function validateWhatsappFreeRatio() {
  const client = await resolveDatabaseClient();
  try {
    const ratioResult = await client.query(
      `
        SELECT event_id, day, wa_free_ratio, free_wa, total_wa
          FROM mv_wa_free_ratio_daily
         WHERE total_wa > 0
         ORDER BY day DESC
         LIMIT 1
      `,
    );
    if (ratioResult.rowCount === 0) {
      throw new Error('mv_wa_free_ratio_daily returned no rows with WhatsApp activity');
    }
    const row = ratioResult.rows[0];
    const baselineResult = await client.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE channel = 'whatsapp') AS total_wa,
          COUNT(*) FILTER (WHERE channel = 'whatsapp' AND is_free) AS free_wa,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE channel = 'whatsapp' AND is_free) /
            NULLIF(COUNT(*) FILTER (WHERE channel = 'whatsapp'), 0),
            2
          ) AS wa_free_ratio
        FROM delivery_logs
        WHERE event_id = $1
          AND created_at >= $2::date
          AND created_at < $2::date + interval '1 day'
      `,
      [row.event_id, row.day],
    );
    const baseline = baselineResult.rows[0] || {};
    if (Number(baseline.total_wa || 0) !== Number(row.total_wa)) {
      throw new Error('Mismatch in total WhatsApp messages between view and base table');
    }
    if (Number(baseline.free_wa || 0) !== Number(row.free_wa)) {
      throw new Error('Mismatch in free WhatsApp messages between view and base table');
    }
    const ratioDiff = Math.abs(Number(baseline.wa_free_ratio || 0) - Number(row.wa_free_ratio || 0));
    if (ratioDiff > 0.01) {
      throw new Error(`WhatsApp free ratio drifted by ${ratioDiff.toFixed(2)} percentage points`);
    }
    return {
      eventId: row.event_id,
      day: row.day,
      value: Number(row.wa_free_ratio),
      freeWa: Number(row.free_wa),
      totalWa: Number(row.total_wa),
    };
  } finally {
    await client.end();
  }
}

async function validateWhatsappSession() {
  const client = await resolveDatabaseClient();
  let phone;
  try {
    const result = await client.query(
      `
        SELECT phone
          FROM wa_sessions
         WHERE expires_at > now()
         ORDER BY expires_at DESC
         LIMIT 1
      `,
    );
    if (result.rowCount === 0) {
      throw new Error('No active WhatsApp sessions found in wa_sessions');
    }
    phone = result.rows[0].phone;
  } finally {
    await client.end();
  }

  const backendBase = await resolveBackendBase();
  const response = await timedFetch(buildUrl(backendBase, `/wa/session/${encodeURIComponent(phone)}`));
  if (!response.ok) {
    throw new Error(`WA session endpoint failed with status ${response.status}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!payload || payload.status === 'closed') {
    throw new Error('WA session endpoint returned closed session for active phone');
  }
  return { phone: payload.phone || phone, status: payload.status };
}

async function validateLogPartitions() {
  const client = await resolveDatabaseClient();
  try {
    const periodResult = await client.query(
      `
        SELECT
          to_char(current_date, 'YYYYMM') AS current_bucket,
          to_char(current_date + interval '1 month', 'YYYYMM') AS next_bucket
      `,
    );
    const { current_bucket: currentBucket, next_bucket: nextBucket } = periodResult.rows[0];
    const checks = [
      { table: 'delivery_logs', bucket: currentBucket },
      { table: 'delivery_logs', bucket: nextBucket },
      { table: 'scan_logs', bucket: currentBucket },
      { table: 'scan_logs', bucket: nextBucket },
    ];
    const missing = [];
    for (const check of checks) {
      const qualified = `public.${check.table}_${check.bucket}`;
      const lookup = await client.query('SELECT to_regclass($1) AS oid', [qualified]);
      if (!lookup.rows[0]?.oid) {
        missing.push(qualified);
      }
    }
    if (missing.length > 0) {
      throw new Error(`Missing partitions: ${missing.join(', ')}`);
    }
    return { current: currentBucket, next: nextBucket };
  } finally {
    await client.end();
  }
}

async function resolveDatabaseClient() {
  if (process.env.DATABASE_URL) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    return client;
  }

  if (cachedDbConfig) {
    const client = new Client(cachedDbConfig);
    await client.connect();
    return client;
  }

  const port = Number.parseInt(process.env.DB_PORT || process.env.PGPORT || '5432', 10);
  const user = process.env.DB_USER || process.env.PGUSER || 'postgres';
  const password = process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres';
  const database = process.env.DB_NAME || process.env.PGDATABASE || 'monotickets';
  const attempts = [];

  for (const host of databaseCandidates) {
    if (!host) continue;
    const config = { host, port, user, password, database };
    const client = new Client(config);
    try {
      await client.connect();
      cachedDbConfig = config;
      return client;
    } catch (error) {
      attempts.push(`${host}:${port} -> ${error.message}`);
    }
  }

  throw new Error(`Unable to connect to database. Attempts: ${attempts.join('; ')}`);
}

function log(payload) {
  console.log(JSON.stringify(payload));
}

function normalizeBase(value) {
  return String(value).replace(/\/+$/, '');
}

function buildUrl(base, path = '') {
  if (!path) {
    return normalizeBase(base);
  }
  const sanitizedBase = normalizeBase(base);
  const sanitizedPath = String(path).replace(/^\/+/, '');
  return `${sanitizedBase}/${sanitizedPath}`;
}

function dedupe(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function loadDotenv() {
  try {
    // Lazy require to avoid adding a dependency when already bundled
    const dotenv = require('dotenv');
    const path = require('node:path');
    const fs = require('node:fs');
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
    }
  } catch (error) {
    // Si dotenv no está disponible (por ejemplo en imagen minimal), seguimos con las variables ya presentes.
    log({
      level: 'debug',
      message: 'dotenv_unavailable_or_missing',
      error: error.message,
    });
  }
}

main().catch((error) => {
  log({ level: 'fatal', message: 'e2e_checks_failed', error: error.message });
  process.exit(1);
});
