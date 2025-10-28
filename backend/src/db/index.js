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
  return withDbClient(async (client) => {
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }, options);
}

export async function query(textOrConfig, params = [], options = {}) {
  const executor = options.client || (await getPool(options));
  if (typeof textOrConfig === 'string') {
    return executor.query(textOrConfig, params);
  }

  const config = { ...textOrConfig };
  if (!config.values && params.length > 0) {
    config.values = params;
  }

  return executor.query(config);
}

function buildPoolConfig(env = process.env) {
  const maxConnections = parsePositiveInt(env.DB_POOL_MAX, 20);
  const maxUses = parsePositiveInt(env.DB_POOL_MAX_USES, 7500);

  const baseConfig = env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL }
    : {
        host: env.DB_HOST || 'database',
        port: Number(env.DB_PORT || 5432),
        user: env.DB_USER || 'postgres',
        password: env.DB_PASSWORD || 'postgres',
        database: env.DB_NAME || env.DB_USER || 'postgres',
      };

  const config = { ...baseConfig, max: maxConnections };
  if (maxUses > 0) {
    config.maxUses = maxUses;
  }

  return config;
}

export async function withDbClient(fn, options = {}) {
  const client = await getPool(options).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
