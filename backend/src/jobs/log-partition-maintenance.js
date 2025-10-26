import '../config/load-env.js';
import { createLogger } from '../logging.js';
import { query as defaultQuery } from '../db/index.js';

const TABLE_CONFIGS = [
  { tableName: 'public.scan_logs', partitionPrefix: 'scan_logs', schema: 'public' },
  { tableName: 'public.delivery_logs', partitionPrefix: 'delivery_logs', schema: 'public' },
];

const MIN_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 180;
const DEFAULT_RETENTION_DAYS = 180;
const DEFAULT_LEAD_DAYS = 5;

export async function runLogPartitionMaintenanceJob(options = {}) {
  const {
    env = process.env,
    logger = createLogger({ env, service: env.SERVICE_NAME || 'partition-maintenance' }),
    now = new Date(),
    dryRun = false,
    db = { query: defaultQuery },
  } = options;

  const retentionDays = normalizeRetentionDays(env.SCAN_LOG_RETENTION_DAYS);
  const leadDays = normalizeLeadDays(env.SCAN_LOG_PARTITION_LEAD_DAYS);

  logger({
    level: 'info',
    message: 'log_partition_maintenance_started',
    retention_days: retentionDays,
    lead_days: leadDays,
    dry_run: dryRun,
  });

  for (const config of TABLE_CONFIGS) {
    await maintainTablePartitions({
      ...config,
      env,
      logger,
      now,
      dryRun,
      retentionDays,
      db,
    });
  }

  logger({ level: 'info', message: 'log_partition_maintenance_completed' });
}

function normalizeRetentionDays(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.trunc(parsed)));
  }
  return DEFAULT_RETENTION_DAYS;
}

function normalizeLeadDays(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 27) {
    return Math.trunc(parsed);
  }
  return DEFAULT_LEAD_DAYS;
}

async function maintainTablePartitions({
  tableName,
  partitionPrefix,
  schema,
  logger,
  now,
  dryRun,
  retentionDays,
  db,
}) {
  const partitions = await listPartitions({ tableName, db });
  const existing = new Map(partitions.map((item) => [item.partition_name, item]));
  const requiredOffsets = [-1, 0, 1];

  for (const offset of requiredOffsets) {
    const monthStart = addUtcMonths(getUtcMonthStart(now), offset);
    const partitionName = buildPartitionName(partitionPrefix, monthStart);
    const partitionExists = existing.has(partitionName);

    if (offset === 1 && !partitionExists) {
      const partitionStart = monthStart;
      const partitionEnd = addUtcMonths(partitionStart, 1);
      if (dryRun) {
        logger({
          level: 'info',
          message: 'log_partition_creation_skipped_dry_run',
          table: tableName,
          partition: partitionName,
          partition_start: partitionStart.toISOString(),
          partition_end: partitionEnd.toISOString(),
        });
      } else {
        try {
          await createPartition({
            tableName,
            partitionName,
            schema,
            partitionStart,
            partitionEnd,
            db,
          });
          logger({
            level: 'info',
            message: 'log_partition_created',
            table: tableName,
            partition: partitionName,
          });
          existing.set(partitionName, {
            partition_name: partitionName,
            qualified_name: schema ? quoteIdentifier(`${schema}.${partitionName}`) : quoteIdentifier(partitionName),
          });
        } catch (error) {
          logger({
            level: 'error',
            message: 'log_partition_creation_failed',
            table: tableName,
            partition: partitionName,
            error: error.message,
          });
        }
      }

      if (!dryRun && !existing.has(partitionName)) {
        logger({
          level: 'error',
          message: 'log_partition_missing_after_attempt',
          table: tableName,
          partition: partitionName,
        });
      }
    }

    if (offset !== 1 && !partitionExists) {
      logger({
        level: 'error',
        message: 'log_partition_missing',
        table: tableName,
        partition: partitionName,
        month_offset: offset,
      });
    }
  }

  await dropExpiredPartitions({
    tableName,
    partitionPrefix,
    retentionDays,
    dryRun,
    now,
    partitions: existing,
    db,
    logger,
  });
}

async function listPartitions({ tableName, db }) {
  const text = `
    SELECT
      child.relname AS partition_name,
      format('%I.%I', childns.nspname, child.relname) AS qualified_name
    FROM pg_inherits
      JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
      JOIN pg_namespace parentns ON parent.relnamespace = parentns.oid
      JOIN pg_class child ON pg_inherits.inhrelid = child.oid
      JOIN pg_namespace childns ON child.relnamespace = childns.oid
    WHERE parent.oid = $1::regclass
  `;
  const result = await db.query(text, [tableName]);
  return result.rows;
}

async function createPartition({ tableName, partitionName, schema, partitionStart, partitionEnd, db }) {
  const qualifiedRegclass = schema ? `${schema}.${partitionName}` : partitionName;
  const existsResult = await db.query('SELECT to_regclass($1) AS oid', [qualifiedRegclass]);
  if (existsResult.rows[0]?.oid) {
    return;
  }

  const createIdentifier = schema
    ? quoteIdentifier(`${schema}.${partitionName}`)
    : quoteIdentifier(partitionName);
  const partitionSql = `CREATE TABLE IF NOT EXISTS ${createIdentifier} PARTITION OF ${tableName} FOR VALUES FROM ($1) TO ($2);`;
  await db.query(partitionSql, [formatTimestamp(partitionStart), formatTimestamp(partitionEnd)]);

  const confirmation = await db.query('SELECT to_regclass($1) AS oid', [qualifiedRegclass]);
  if (!confirmation.rows[0]?.oid) {
    throw new Error(`Partition ${qualifiedRegclass} was not created`);
  }
}

async function dropExpiredPartitions({
  tableName,
  partitionPrefix,
  retentionDays,
  dryRun,
  now,
  partitions,
  db,
  logger,
}) {
  const cutoff = addUtcDays(getUtcStartOfDay(now), -retentionDays);
  for (const [partitionName, partition] of partitions.entries()) {
    const partitionMonthStart = parsePartitionMonthStart(partitionName, partitionPrefix);
    if (!partitionMonthStart) {
      continue;
    }
    const partitionEnd = addUtcMonths(partitionMonthStart, 1);
    if (partitionEnd <= cutoff) {
      if (dryRun) {
        logger({
          level: 'info',
          message: 'log_partition_drop_skipped_dry_run',
          table: tableName,
          partition: partitionName,
        });
        continue;
      }
      const qualified = partition.qualified_name || quoteIdentifier(partitionName);
      try {
        await db.query(`DROP TABLE IF EXISTS ${qualified} CASCADE;`);
        logger({
          level: 'info',
          message: 'log_partition_dropped',
          table: tableName,
          partition: partitionName,
        });
      } catch (error) {
        logger({
          level: 'error',
          message: 'log_partition_drop_failed',
          table: tableName,
          partition: partitionName,
          error: error.message,
        });
      }
    }
  }
}

export function buildPartitionName(prefix, monthStartDate) {
  const year = monthStartDate.getUTCFullYear();
  const month = monthStartDate.getUTCMonth() + 1;
  return `${prefix}_${year}${String(month).padStart(2, '0')}`;
}

export function parsePartitionMonthStart(partitionName, prefix) {
  const pattern = new RegExp(`^${escapeRegex(prefix)}_(\\d{4})(\\d{2})$`);
  const match = partitionName.match(pattern);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  return new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getUtcMonthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

function addUtcMonths(date, offset) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1, 0, 0, 0, 0));
}

function getUtcStartOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatTimestamp(date) {
  return date.toISOString().replace('T', ' ').replace('Z', '+00');
}

function quoteIdentifier(identifier) {
  return identifier
    .split('.')
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join('.');
}

export { normalizeRetentionDays, normalizeLeadDays, getUtcMonthStart, addUtcMonths };
