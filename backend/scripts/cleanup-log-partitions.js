#!/usr/bin/env node
import '../src/config/load-env.js';
import { createLogger } from '../src/logging.js';
import { runLogPartitionMaintenanceJob } from '../src/jobs/log-partition-maintenance.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const logger = createLogger({ env: process.env, service: process.env.SERVICE_NAME || 'partition-cleanup' });

logger({
  level: 'info',
  message: 'manual_log_partition_cleanup_started',
  dry_run: dryRun,
  retention_days: process.env.SCAN_LOG_RETENTION_DAYS,
});

runLogPartitionMaintenanceJob({ env: process.env, logger, dryRun })
  .then(() => {
    logger({ level: 'info', message: 'manual_log_partition_cleanup_completed' });
  })
  .catch((error) => {
    logger({ level: 'error', message: 'manual_log_partition_cleanup_failed', error: error.message });
    process.exitCode = 1;
  });
