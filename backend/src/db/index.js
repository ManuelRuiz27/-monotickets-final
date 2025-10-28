import { Pool } from 'pg';

import { createLogger } from '../logging.js';

let pool;
let isInitialized = false;

export function getPool(options = {}) {
  if (pool) {
    return pool;
  }

  const { env = process.env } = options;
  const logger = options.logger || createLogger({ env, service: env.SERVICE_NAME || 'backend-api' });

  const config = buildPoolConfig(env);
  pool = new Pool(config);
  pool.on('error', (error) => {
    logger({ level: 'error', message: 'db_pool_error', error: error.message });
  });

  return pool;
}

export async function initDb(options = {}) {
  if (isInitialized) return getPool(options);
  const instance = getPool(options);
  try {
    await instance.query('SELECT 1');
    isInitialized = true;
  } catch (error) {
    const logger = options.logger || createLogger({ env: options.env || process.env });
    logger({ level: 'error', message: 'db_initialization_failed', error: error.message });
    throw error;
  }
  return instance;
}

export async function withTransaction(fn, options = {}) {
  const client = await getPool(options).connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function query(textOrConfig, params = [], options = {}) {
  const client = await getPool(options);
  if (typeof textOrConfig === 'string') {
    return client.query(textOrConfig, params);
  }

  const config = { ...textOrConfig };
  if (!config.values && params.length > 0) {
    config.values = params;
  }

  return client.query(config);
}

function buildPoolConfig(env = process.env) {
  if (env.DATABASE_URL) {
    return { connectionString: env.DATABASE_URL, max: Number(env.DB_POOL_MAX || 10) };
  }
  return {
    host: env.DB_HOST || 'database',
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USER || 'postgres',
    password: env.DB_PASSWORD || 'postgres',
    database: env.DB_NAME || env.DB_USER || 'postgres',
    max: Number(env.DB_POOL_MAX || 10),
  };
}
