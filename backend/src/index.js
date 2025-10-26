import './config/load-env.js';
import { createServer, ensureDependencies, log } from './server.js';
import { initializeDatabase } from './db/bootstrap.js';
import { createLogger } from './logging.js';

const PORT = Number(process.env.PORT || 8080);
const APP_ENV = process.env.APP_ENV || 'development';

const logger = createLogger({ env: process.env, service: process.env.SERVICE_NAME || 'backend-api' });
const server = createServer({ env: process.env, logger });

ensureDependencies({ env: process.env, logger })
  .then(() => initializeDatabase({ env: process.env, logger }))
  .then(() => {
    server.listen(PORT, () => {
      log({ level: 'info', message: 'backend_api_started', port: PORT, env: APP_ENV });
    });
  })
  .catch((error) => {
    log({ level: 'fatal', message: 'startup_failed', error: error.message });
    process.exit(1);
  });
