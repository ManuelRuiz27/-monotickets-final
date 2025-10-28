import cluster from 'node:cluster';
import { randomUUID } from 'node:crypto';

const HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const metricsRegistry = new Map();
const requestTotals = new Map();
const serverErrorTotals = new Map();
const queueBacklogGauge = new Map();
const queueFailuresCounter = new Map();
const queueProcessedCounter = new Map();

const MESSAGE_TYPES = {
  OBSERVE_HTTP_DURATION: 'metrics:observeHttpDuration',
  INCREMENT_QUEUE_FAILURES: 'metrics:incrementQueueFailures',
  INCREMENT_QUEUE_PROCESSED: 'metrics:incrementQueueProcessed',
  UPDATE_QUEUE_BACKLOG: 'metrics:updateQueueBacklog',
  RENDER: 'metrics:render',
  RESPONSE: 'metrics:response',
};

const pendingRequests = new Map();

const isPrimary = (cluster.isPrimary ?? cluster.isMaster) === true;
const isWorker = cluster.isWorker === true;

if (isWorker && typeof process !== 'undefined') {
  process.on('message', (message) => {
    if (!message || message.type !== MESSAGE_TYPES.RESPONSE) return;
    const { id, payload, error } = message;
    if (!pendingRequests.has(id)) return;
    const { resolve, reject, timeout } = pendingRequests.get(id);
    clearTimeout(timeout);
    pendingRequests.delete(id);
    if (error) {
      reject(new Error(error));
    } else {
      resolve(payload);
    }
  });
}

function resolveServiceLabel(service) {
  return service || process.env.SERVICE_NAME || 'backend-api';
}

function applyObserveHttpDuration({ service, method, route, status, durationMs }) {
  const normalizedService = resolveServiceLabel(service);
  const normalizedMethod = method.toUpperCase();
  const key = `${normalizedService}::${normalizedMethod}::${status}::${route}`;
  if (!metricsRegistry.has(key)) {
    metricsRegistry.set(key, {
      count: 0,
      sum: 0,
      buckets: new Array(HISTOGRAM_BUCKETS.length + 1).fill(0),
    });
  }

  const metric = metricsRegistry.get(key);
  metric.count += 1;
  metric.sum += durationMs;

  const bucketIndex = HISTOGRAM_BUCKETS.findIndex((boundary) => durationMs <= boundary);
  if (bucketIndex === -1) {
    metric.buckets[HISTOGRAM_BUCKETS.length] += 1;
  } else {
    metric.buckets[bucketIndex] += 1;
  }

  const totalKey = `${normalizedService}::${normalizedMethod}::${status}::${route}`;
  const current = requestTotals.get(totalKey) || 0;
  requestTotals.set(totalKey, current + 1);

  if (String(status).startsWith('5')) {
    const errorKey = `${normalizedService}::${normalizedMethod}::${route}`;
    const total = serverErrorTotals.get(errorKey) || 0;
    serverErrorTotals.set(errorKey, total + 1);
  }
}

function applyIncrementQueueFailures(queue, service) {
  const normalizedService = resolveServiceLabel(service);
  const key = `${normalizedService}::${queue}`;
  const current = queueFailuresCounter.get(key) || 0;
  queueFailuresCounter.set(key, current + 1);
}

function applyIncrementQueueProcessed(queue, service) {
  const normalizedService = resolveServiceLabel(service);
  const key = `${normalizedService}::${queue}`;
  const current = queueProcessedCounter.get(key) || 0;
  queueProcessedCounter.set(key, current + 1);
}

function applyUpdateQueueBacklog(snapshot = [], service) {
  const normalizedService = resolveServiceLabel(service);
  const seen = new Set();
  snapshot.forEach(({ label, waiting = 0, delayed = 0 }) => {
    const key = `${normalizedService}::${label}`;
    seen.add(key);
    queueBacklogGauge.set(key, Number(waiting || 0) + Number(delayed || 0));
  });
  for (const key of Array.from(queueBacklogGauge.keys())) {
    if (key.startsWith(`${normalizedService}::`) && !seen.has(key)) {
      queueBacklogGauge.delete(key);
    }
  }
}

function buildMetricsPayload() {
  const lines = [
    '# HELP http_request_duration_ms HTTP request duration in milliseconds.',
    '# TYPE http_request_duration_ms histogram',
  ];

  for (const [key, metric] of metricsRegistry.entries()) {
    const [service, method, status, route] = key.split('::');
    let cumulative = 0;
    HISTOGRAM_BUCKETS.forEach((boundary, index) => {
      cumulative += metric.buckets[index];
      lines.push(
        `http_request_duration_ms_bucket{le="${boundary}",service="${service}",method="${method}",route="${route}",status="${status}"} ${cumulative}`,
      );
    });
    cumulative += metric.buckets[HISTOGRAM_BUCKETS.length];
    lines.push(
      `http_request_duration_ms_bucket{le="+Inf",service="${service}",method="${method}",route="${route}",status="${status}"} ${cumulative}`,
    );
    lines.push(
      `http_request_duration_ms_sum{service="${service}",method="${method}",route="${route}",status="${status}"} ${metric.sum}`,
    );
    lines.push(
      `http_request_duration_ms_count{service="${service}",method="${method}",route="${route}",status="${status}"} ${metric.count}`,
    );
  }

  if (requestTotals.size > 0) {
    lines.push('# HELP http_requests_total Total HTTP requests processed.');
    lines.push('# TYPE http_requests_total counter');
    for (const [key, value] of requestTotals.entries()) {
      const [service, method, status, route] = key.split('::');
      lines.push(
        `http_requests_total{service="${service}",method="${method}",route="${route}",status="${status}"} ${value}`,
      );
    }
  }

  if (serverErrorTotals.size > 0) {
    lines.push('# HELP http_requests_5xx_total Total number of HTTP 5xx responses.');
    lines.push('# TYPE http_requests_5xx_total counter');
    for (const [key, value] of serverErrorTotals.entries()) {
      const [service, method, route] = key.split('::');
      lines.push(`http_requests_5xx_total{service="${service}",method="${method}",route="${route}"} ${value}`);
    }
  }

  if (queueBacklogGauge.size > 0) {
    lines.push('# HELP queue_backlog Pending jobs in queue (waiting + delayed).');
    lines.push('# TYPE queue_backlog gauge');
    for (const [key, pending] of queueBacklogGauge.entries()) {
      const [service, queue] = key.split('::');
      lines.push(`queue_backlog{service="${service}",queue="${queue}"} ${pending}`);
    }
  }

  if (queueFailuresCounter.size > 0) {
    lines.push('# HELP jobs_failed_total Total number of failed queue jobs.');
    lines.push('# TYPE jobs_failed_total counter');
    for (const [key, total] of queueFailuresCounter.entries()) {
      const [service, queue] = key.split('::');
      lines.push(`jobs_failed_total{service="${service}",queue="${queue}"} ${total}`);
    }
  }

  if (queueProcessedCounter.size > 0) {
    lines.push('# HELP jobs_processed_total Total number of completed queue jobs.');
    lines.push('# TYPE jobs_processed_total counter');
    for (const [key, total] of queueProcessedCounter.entries()) {
      const [service, queue] = key.split('::');
      lines.push(`jobs_processed_total{service="${service}",queue="${queue}"} ${total}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function sendToPrimary(type, payload) {
  if (!isWorker || typeof process.send !== 'function') {
    return false;
  }
  process.send({ type, payload });
  return true;
}

function requestFromPrimary(type, payload) {
  if (!isWorker || typeof process.send !== 'function') {
    return Promise.resolve(buildMetricsPayload());
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Timed out waiting for metrics response from primary process.'));
    }, 5000);
    pendingRequests.set(id, { resolve, reject, timeout });
    process.send({ type, id, payload });
  });
}

export function initializeMasterMetrics() {
  if (!isPrimary) return;
  if (initializeMasterMetrics.initialized) return;
  initializeMasterMetrics.initialized = true;

  cluster.on('message', (worker, message) => {
    if (!message || typeof message !== 'object') return;
    const { type, payload, id } = message;
    switch (type) {
      case MESSAGE_TYPES.OBSERVE_HTTP_DURATION:
        applyObserveHttpDuration(payload);
        break;
      case MESSAGE_TYPES.INCREMENT_QUEUE_FAILURES:
        applyIncrementQueueFailures(payload.queue, payload.service);
        break;
      case MESSAGE_TYPES.INCREMENT_QUEUE_PROCESSED:
        applyIncrementQueueProcessed(payload.queue, payload.service);
        break;
      case MESSAGE_TYPES.UPDATE_QUEUE_BACKLOG:
        applyUpdateQueueBacklog(payload.snapshot, payload.service);
        break;
      case MESSAGE_TYPES.RENDER: {
        const result = buildMetricsPayload();
        worker.send({ type: MESSAGE_TYPES.RESPONSE, id, payload: result });
        break;
      }
      default:
        break;
    }
  });
}

initializeMasterMetrics.initialized = false;

export function observeHttpDuration({ service, method, route, status, durationMs }) {
  const payload = { service, method, route, status, durationMs };
  if (!sendToPrimary(MESSAGE_TYPES.OBSERVE_HTTP_DURATION, payload)) {
    applyObserveHttpDuration(payload);
  }
}

export async function renderMetrics() {
  if (!isWorker) {
    return buildMetricsPayload();
  }

  try {
    return await requestFromPrimary(MESSAGE_TYPES.RENDER);
  } catch (error) {
    // Fallback to local snapshot if primary is unreachable.
    return buildMetricsPayload();
  }
}

export function incrementQueueFailures(queue, options = {}) {
  const payload = { queue, service: options.service };
  if (!sendToPrimary(MESSAGE_TYPES.INCREMENT_QUEUE_FAILURES, payload)) {
    applyIncrementQueueFailures(queue, options.service);
  }
}

export function incrementQueueProcessed(queue, options = {}) {
  const payload = { queue, service: options.service };
  if (!sendToPrimary(MESSAGE_TYPES.INCREMENT_QUEUE_PROCESSED, payload)) {
    applyIncrementQueueProcessed(queue, options.service);
  }
}

export function updateQueueBacklog(snapshot = [], options = {}) {
  const payload = { snapshot, service: options.service };
  if (!sendToPrimary(MESSAGE_TYPES.UPDATE_QUEUE_BACKLOG, payload)) {
    applyUpdateQueueBacklog(snapshot, options.service);
  }
}

