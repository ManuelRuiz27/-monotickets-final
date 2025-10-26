import { strict as assert } from 'node:assert';
import test from 'node:test';

import { runLogPartitionMaintenanceJob } from '../src/jobs/log-partition-maintenance.js';

function createDbMock(responses = []) {
  const queue = [...responses];
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      const next = queue.shift();
      if (typeof next === 'function') {
        return await next(text, params);
      }
      if (next) {
        return next;
      }
      return { rows: [] };
    },
  };
}

function collectLogger() {
  const entries = [];
  const logger = (payload) => {
    entries.push(payload);
  };
  return { logger, entries };
}

test('runLogPartitionMaintenanceJob creates next-month partitions and drops expired ones', async () => {
  const now = new Date(Date.UTC(2024, 4, 15, 12, 0, 0));
  const env = { SCAN_LOG_RETENTION_DAYS: '120' };
  const scanNext = { rows: [{ oid: null }] };
  const scanCreated = { rows: [] };
  const scanConfirm = { rows: [{ oid: 'public.scan_logs_202406' }] };
  const db = createDbMock([
    {
      rows: [
        { partition_name: 'scan_logs_202404', qualified_name: 'public.scan_logs_202404' },
        { partition_name: 'scan_logs_202405', qualified_name: 'public.scan_logs_202405' },
        { partition_name: 'scan_logs_202309', qualified_name: 'public.scan_logs_202309' },
      ],
    },
    scanNext,
    scanCreated,
    scanConfirm,
    { rows: [] },
    {
      rows: [
        { partition_name: 'delivery_logs_202404', qualified_name: 'public.delivery_logs_202404' },
        { partition_name: 'delivery_logs_202405', qualified_name: 'public.delivery_logs_202405' },
        { partition_name: 'delivery_logs_202309', qualified_name: 'public.delivery_logs_202309' },
      ],
    },
    { rows: [] },
  ]);

  const { logger, entries } = collectLogger();

  await runLogPartitionMaintenanceJob({ env, logger, now, db });

  const createCall = db.calls.find((call) => call.text.includes('CREATE TABLE'));
  assert.ok(createCall, 'expected CREATE TABLE call for next partition');
  assert.ok(createCall.text.includes('scan_logs_202406'));

  const dropCalls = db.calls.filter((call) => call.text.startsWith('DROP TABLE'));
  assert.equal(dropCalls.length, 2, 'expected drop for expired scan and delivery partitions');

  const createdLog = entries.find((entry) => entry.message === 'log_partition_created');
  assert.ok(createdLog, 'expected log_partition_created entry');
  assert.equal(createdLog.partition, 'scan_logs_202406');

  const droppedLogs = entries.filter((entry) => entry.message === 'log_partition_dropped');
  assert.equal(droppedLogs.length, 2, 'expected dropped logs for both tables');

  const missingLogs = entries.filter((entry) => entry.message === 'log_partition_missing');
  assert.equal(missingLogs.length, 0, 'no missing partition logs expected when partitions exist');
});

test('runLogPartitionMaintenanceJob logs missing partitions for previous month', async () => {
  const now = new Date(Date.UTC(2024, 4, 2, 8, 0, 0));
  const env = { SCAN_LOG_RETENTION_DAYS: '150' };
  const db = createDbMock([
    {
      rows: [
        { partition_name: 'scan_logs_202405', qualified_name: 'public.scan_logs_202405' },
        { partition_name: 'scan_logs_202406', qualified_name: 'public.scan_logs_202406' },
      ],
    },
    {
      rows: [
        { partition_name: 'delivery_logs_202405', qualified_name: 'public.delivery_logs_202405' },
        { partition_name: 'delivery_logs_202406', qualified_name: 'public.delivery_logs_202406' },
      ],
    },
  ]);

  const { logger, entries } = collectLogger();

  await runLogPartitionMaintenanceJob({ env, logger, now, db, dryRun: true });

  const missingLogs = entries.filter((entry) => entry.message === 'log_partition_missing');
  assert.ok(missingLogs.length >= 1, 'expected missing partition logs');
  const previousLog = missingLogs.find((entry) => entry.partition === 'scan_logs_202404');
  assert.ok(previousLog, 'expected missing log for previous month partition');
  assert.equal(previousLog.month_offset, -1);
});
