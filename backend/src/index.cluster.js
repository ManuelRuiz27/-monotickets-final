import './config/load-env.js';
import cluster from 'node:cluster';
import os from 'node:os';

import { createServer, ensureDependencies, log } from './server.js';
import { initializeDatabase } from './db/bootstrap.js';
import { createLogger } from './logging.js';
import { initializeMasterMetrics } from './metrics/registry.js';
import { ensureRedis } from './redis/client.js';

const PORT = Number(process.env.PORT || 8080);
const APP_ENV = process.env.APP_ENV || 'development';
const SERVICE_NAME = process.env.SERVICE_NAME || 'backend-api';
const WORKER_COUNT = Number(process.env.WEB_CONCURRENCY || os.cpus().length || 1);

const isPrimary = (cluster.isPrimary ?? cluster.isMaster) === true;

if (isPrimary) {
  const logger = createLogger({ env: process.env, service: SERVICE_NAME });

  initializeMasterMetrics();

  ensureDependencies({ env: process.env, logger })
    .then(() => initializeDatabase({ env: process.env, logger }))
    .then(() => {
      for (let i = 0; i < WORKER_COUNT; i += 1) {
        cluster.fork();
      }
    })
    .catch((error) => {
      log({ level: 'fatal', message: 'startup_failed', error: error.message }, { logger });
      process.exit(1);
    });

  cluster.on('online', (worker) => {
    log({ level: 'info', message: 'worker_online', worker: worker.id }, { logger });
  });

  cluster.on('exit', (worker, code, signal) => {
    log(
      {
        level: 'error',
        message: 'worker_exit',
        worker: worker.id,
        code,
        signal,
      },
      { logger },
    );
    cluster.fork();
  });
} else {
  const logger = createLogger({ env: process.env, service: `${SERVICE_NAME}-worker` });

  const server = createServer({ env: process.env, logger });

  Promise.all([
    ensureRedis({ env: process.env, logger }),
    new Promise((resolve) => {
      server.listen(PORT, () => resolve());
    }),
  ])
    .then(() => {
      log({ level: 'info', message: 'backend_api_worker_started', port: PORT, env: APP_ENV, worker: cluster.worker.id }, { logger });
    })
    .catch((error) => {
      log({ level: 'fatal', message: 'worker_startup_failed', error: error.message, worker: cluster.worker.id }, { logger });
      process.exit(1);
    });
}

