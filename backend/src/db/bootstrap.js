import { query } from './index.js';
import { createLogger } from '../logging.js';
import { normalizeWhatsappPhone } from '../lib/phone.js';

async function ensureExtensions(logger) {
  await query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  logger({ level: 'info', message: 'db_extension_ready', extension: 'pgcrypto' });
}

async function ensureCoreTables(logger) {
  await query(`
    CREATE TABLE IF NOT EXISTS events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      status text NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS guests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name text NOT NULL,
      phone text NOT NULL,
      email text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'scanned')),
      confirmation_payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS invites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      code text NOT NULL,
      links jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (event_id, code)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS scan_logs (
      id bigserial PRIMARY KEY,
      event_id uuid,
      guest_id uuid,
      result text NOT NULL CHECK (result IN ('valid', 'duplicate', 'invalid')),
      device jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query('CREATE INDEX IF NOT EXISTS idx_invites_event_code ON invites(event_id, code)');
  await query('CREATE INDEX IF NOT EXISTS idx_guests_event_status ON guests(event_id, status)');
  await query('CREATE INDEX IF NOT EXISTS idx_scan_logs_event_created_at ON scan_logs(event_id, created_at DESC)');

  logger({ level: 'info', message: 'db_core_tables_ready' });
}

async function ensureDeliveryInfrastructure(logger) {
  await query(`
    CREATE TABLE IF NOT EXISTS delivery_requests (
      id bigserial PRIMARY KEY,
      organizer_id uuid NOT NULL,
      event_id uuid NOT NULL,
      guest_id uuid NOT NULL,
      channel text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
      template text NOT NULL,
      payload jsonb,
      metadata jsonb,
      dedupe_key text,
      correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
      last_job_id text,
      current_status text NOT NULL DEFAULT 'queued' CHECK (current_status IN (
        'queued', 'processing', 'sent', 'delivered', 'failed', 'duplicate', 'retrying'
      )),
      attempt_count integer NOT NULL DEFAULT 0,
      last_provider_ref text,
      last_error jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_requests_correlation ON delivery_requests(correlation_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_delivery_requests_guest_template ON delivery_requests(event_id, guest_id, template, created_at DESC)');

  await query(`
    CREATE TABLE IF NOT EXISTS wa_sessions (
      id bigserial PRIMARY KEY,
      phone text NOT NULL UNIQUE,
      started_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      last_message_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS last_message_at timestamptz');
  await query("ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb");
  await query('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()');
  await query('ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()');
  await query('CREATE INDEX IF NOT EXISTS idx_wa_sessions_expires_at ON wa_sessions(expires_at DESC)');

  await convertLegacyDeliveryLogs(logger);
  await ensureDeliveryPartitions(logger);

  await query('ALTER TABLE delivery_logs ADD COLUMN IF NOT EXISTS is_free boolean NOT NULL DEFAULT false');
  await query('ALTER TABLE delivery_logs ALTER COLUMN is_free SET DEFAULT false');
  await query('ALTER TABLE delivery_logs ADD COLUMN IF NOT EXISTS session_id bigint REFERENCES wa_sessions(id)');

  await query(`
    CREATE INDEX IF NOT EXISTS idx_delivery_logs_request_attempt
      ON delivery_logs(request_id, attempt DESC)
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_delivery_logs_id ON delivery_logs(id)');
  await query('CREATE INDEX IF NOT EXISTS idx_delivery_logs_session_id ON delivery_logs(session_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_delivery_logs_is_free ON delivery_logs(is_free)');

  await query(`
    CREATE TABLE IF NOT EXISTS delivery_provider_refs (
      provider_ref text PRIMARY KEY,
      request_id bigint NOT NULL REFERENCES delivery_requests(id) ON DELETE CASCADE,
      guest_id uuid,
      attempt_id bigint,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query('ALTER TABLE delivery_provider_refs ADD COLUMN IF NOT EXISTS guest_id uuid');
  await query('CREATE INDEX IF NOT EXISTS idx_delivery_provider_request ON delivery_provider_refs(request_id)');
  await query(
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_indexes
           WHERE schemaname = 'public'
             AND tablename = 'delivery_provider_refs'
             AND indexname = 'idx_delivery_provider_guest'
        ) THEN
          EXECUTE 'CREATE UNIQUE INDEX idx_delivery_provider_guest ON delivery_provider_refs(provider_ref, guest_id)';
        END IF;
      END
      $$;
    `,
  );

  logger({ level: 'info', message: 'db_delivery_tables_ready' });
}

async function ensureLedgerTickets(logger) {
  await query(`
    CREATE TABLE IF NOT EXISTS ledger_tickets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organizer_id uuid NOT NULL,
      event_id uuid,
      tickets_assigned integer NOT NULL,
      tickets_used integer NOT NULL DEFAULT 0,
      tickets_type text NOT NULL,
      unit_price_mxn numeric(12, 2) NOT NULL DEFAULT 0,
      amount_due numeric(14, 2) NOT NULL DEFAULT 0,
      paid boolean NOT NULL DEFAULT false,
      payment_ref text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_ledger_tickets_organizer ON ledger_tickets(organizer_id, paid)
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_tickets_payment_ref ON ledger_tickets(payment_ref)
      WHERE payment_ref IS NOT NULL
  `);
  logger({ level: 'info', message: 'db_ledger_tickets_ready' });
}

async function convertLegacyDeliveryLogs(logger) {
  const hasRequestIdColumn = await query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'delivery_logs'
        AND column_name = 'request_id'
      LIMIT 1`,
  );
  if (hasRequestIdColumn.rowCount > 0) {
    return;
  }

  const legacyTableExists = await query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'delivery_logs'
      LIMIT 1`,
  );
  if (legacyTableExists.rowCount > 0) {
    await query('ALTER TABLE delivery_logs RENAME TO delivery_logs_legacy');
  }

  await query(`
    CREATE TABLE IF NOT EXISTS delivery_logs (
      id bigserial,
      request_id bigint NOT NULL REFERENCES delivery_requests(id) ON DELETE CASCADE,
      attempt integer NOT NULL,
      status text NOT NULL CHECK (status IN (
        'queued', 'processing', 'sent', 'delivered', 'failed', 'duplicate', 'retrying'
      )),
      provider_ref text,
      error jsonb,
      metadata jsonb,
      is_free boolean NOT NULL DEFAULT false,
      session_id bigint REFERENCES wa_sessions(id),
      queued_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    ) PARTITION BY RANGE (created_at)
  `);

  if (legacyTableExists.rowCount === 0) {
    return;
  }
  await query(`
    DO $$
    DECLARE
      month_key text;
      table_name text;
      start_at timestamptz;
      end_at timestamptz;
    BEGIN
      FOR month_key IN
        SELECT to_char(date_trunc('month', current_date) + (month_offset * interval '1 month'), 'YYYYMM')
        FROM generate_series(-1, 2) AS offsets(month_offset)
      LOOP
        table_name := format('delivery_logs_%s', month_key);
        start_at := to_timestamp(month_key || '01', 'YYYYMMDD');
        end_at := start_at + interval '1 month';

        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF delivery_logs FOR VALUES FROM (%L) TO (%L);',
          table_name,
          start_at,
          end_at
        );
      END LOOP;
    END
    $$;
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS delivery_logs_default PARTITION OF delivery_logs DEFAULT;
  `);

  const migrated = await query(`
    WITH legacy AS (
      SELECT *
        FROM delivery_logs_legacy
    ),
    inserted_requests AS (
      INSERT INTO delivery_requests (
        organizer_id,
        event_id,
        guest_id,
        channel,
        template,
        payload,
        metadata,
        dedupe_key,
        current_status,
        attempt_count,
        last_provider_ref,
        last_error,
        created_at,
        updated_at
      )
      SELECT
        organizer_id,
        event_id,
        guest_id,
        channel,
        template,
        NULL,
        NULL,
        NULL,
        status,
        1,
        provider_ref,
        error,
        COALESCE(created_at, now()),
        COALESCE(updated_at, now())
      FROM legacy
      RETURNING id, event_id, guest_id, template, created_at
    )
    INSERT INTO delivery_logs (
      request_id,
      attempt,
      status,
      provider_ref,
      error,
      metadata,
      queued_at,
      started_at,
      completed_at,
      created_at
    )
    SELECT
      dr.id,
      1,
      l.status,
      l.provider_ref,
      l.error,
      NULL,
      COALESCE(l.created_at, now()),
      COALESCE(l.created_at, now()),
      COALESCE(l.updated_at, now()),
      COALESCE(l.created_at, now())
    FROM delivery_logs_legacy l
    JOIN inserted_requests dr
      ON dr.event_id = l.event_id
     AND dr.guest_id = l.guest_id
     AND dr.template = l.template
  `);

  logger({
    level: 'info',
    message: 'db_delivery_legacy_migrated',
    migrated_rows: migrated.rowCount,
  });

  await query('DROP TABLE IF EXISTS delivery_logs_legacy');

  await query(`
    INSERT INTO delivery_provider_refs (provider_ref, request_id, attempt_id, created_at)
    SELECT provider_ref, request_id, id, created_at
      FROM delivery_logs
     WHERE provider_ref IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM delivery_provider_refs dpr WHERE dpr.provider_ref = delivery_logs.provider_ref
       )
  `);
}

async function ensureDeliveryPartitions(logger) {
  await query(`
    DO $$
    DECLARE
      month_key text;
      table_name text;
      start_at timestamptz;
      end_at timestamptz;
    BEGIN
      FOR month_key IN
        SELECT to_char(date_trunc('month', current_date) + (month_offset * interval '1 month'), 'YYYYMM')
        FROM generate_series(-1, 2) AS offsets(month_offset)
      LOOP
        table_name := format('delivery_logs_%s', month_key);
        start_at := to_timestamp(month_key || '01', 'YYYYMMDD');
        end_at := start_at + interval '1 month';

        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF delivery_logs FOR VALUES FROM (%L) TO (%L);',
          table_name,
          start_at,
          end_at
        );
      END LOOP;
    END
    $$;
  `);
  logger({ level: 'info', message: 'db_delivery_partitions_ready' });
}

async function seedBaselineData(logger) {
  const validInviteCode = process.env.SCAN_QR_VALID || 'MONO-QR-0001';
  const duplicateInviteCode = process.env.SCAN_QR_DUP || 'MONO-QR-0001-DUP';
  const expiredInviteCode = process.env.SCAN_QR_EXPIRED || 'MONO-QR-ARCHIVED';
  const demoEventName = 'Demo Experience';

  let baseEvent = await query(
    `
      SELECT id, organizer_id
        FROM events
       WHERE name = $1
       LIMIT 1
    `,
    [demoEventName],
  );

  if (baseEvent.rowCount === 0) {
    baseEvent = await query(
      `
        SELECT id, organizer_id
          FROM events
         ORDER BY created_at ASC
         LIMIT 1
      `,
    );
  }

  let eventId;
  if (baseEvent.rowCount === 0) {
    const organizerResult = await query(
      `
        INSERT INTO organizers (name)
        VALUES ($1)
        RETURNING id
      `,
      ['Seed Organizer'],
    );
    const organizerId = organizerResult.rows[0].id;
    const eventResult = await query(
      `
        INSERT INTO events (organizer_id, name, type, status, landing_ttl_days, starts_at, ends_at)
        VALUES ($1, $2, 'standard', 'active', $3, now() - interval '1 hour', now() + interval '5 hours')
        RETURNING id
      `,
      [organizerId, demoEventName, Number(process.env.LANDING_TTL_DEFAULT_DAYS || 180)],
    );
    eventId = eventResult.rows[0].id;
    logger({ level: 'info', message: 'db_seed_event_created', event_id: eventId });
  } else {
    eventId = baseEvent.rows[0].id;
    await query(
      `
        UPDATE events
           SET name = $2,
               status = 'active',
               type = COALESCE(type, 'standard'),
               landing_ttl_days = COALESCE(landing_ttl_days, $3),
               starts_at = now() - interval '1 hour',
               ends_at = now() + interval '5 hours'
         WHERE id = $1
      `,
      [eventId, demoEventName, Number(process.env.LANDING_TTL_DEFAULT_DAYS || 180)],
    );
    await query('DELETE FROM delivery_requests WHERE event_id = $1', [eventId]);
    await query('DELETE FROM scan_logs WHERE event_id = $1', [eventId]);
    await query('DELETE FROM guests WHERE event_id = $1', [eventId]);
    logger({ level: 'info', message: 'db_seed_event_reset', event_id: eventId });
  }

  const guestRows = await query(
    `
      INSERT INTO guests (event_id, name, phone, email, status, confirmation_payload)
      VALUES
        ($1, $2, $3, $4, 'confirmed', jsonb_build_object('channel', 'whatsapp')),
        ($1, $5, $6, $7, 'pending', NULL),
        ($1, $8, $9, $10, 'scanned', jsonb_build_object('channel', 'email'))
      RETURNING id, name, status
    `,
    [
      eventId,
      'Ada Lovelace',
      '+525511001001',
      'ada@example.com',
      'Grace Hopper',
      '+525511001002',
      'grace@example.com',
      'Alan Turing',
      '+525511001003',
      'alan@example.com',
    ],
  );

  const guestsByStatus = guestRows.rows.reduce((acc, guest) => {
    acc[guest.status] = guest;
    return acc;
  }, {});

  const seedSessions = {};
  const sessionSeeds = [
    { key: 'confirmed', phone: guestsByStatus.confirmed?.phone, label: 'confirmed_guest' },
    { key: 'pending', phone: guestsByStatus.pending?.phone, label: 'pending_guest' },
  ];
  for (const target of sessionSeeds) {
    const normalizedPhone = normalizeWhatsappPhone(target.phone);
    if (!normalizedPhone) {
      continue;
    }
    const result = await query(
      `
        INSERT INTO wa_sessions (phone, started_at, expires_at, metadata, last_message_at)
        VALUES (
          $1,
          now() - interval '30 minutes',
          now() + interval '23 hours',
          jsonb_build_object('seed', true, 'label', $2),
          now()
        )
        ON CONFLICT (phone) DO UPDATE
          SET started_at = EXCLUDED.started_at,
              expires_at = EXCLUDED.expires_at,
              metadata = jsonb_strip_nulls(wa_sessions.metadata || EXCLUDED.metadata),
              last_message_at = now(),
              updated_at = now()
        RETURNING id
      `,
      [normalizedPhone, target.label],
    );
    seedSessions[target.key] = result.rows[0]?.id || null;
  }

  await query(
    `
      INSERT INTO invites (event_id, guest_id, code, links)
      VALUES
        ($1, $2, $3, jsonb_build_object('invite', '/public/invite/' || $3, 'confirm', '/public/confirm/' || $3)),
        ($1, $4, $5, jsonb_build_object('invite', '/public/invite/' || $5, 'confirm', '/public/confirm/' || $5)),
        ($1, $6, $7, jsonb_build_object('invite', '/public/invite/' || $7, 'confirm', '/public/confirm/' || $7))
    `,
    [
      eventId,
      guestsByStatus.confirmed.id,
      validInviteCode,
      guestsByStatus.pending.id,
      expiredInviteCode,
      guestsByStatus.scanned.id,
      duplicateInviteCode,
    ],
  );

  await query(
    `
      INSERT INTO scan_logs (event_id, guest_id, result, device)
      VALUES
        ($1, $2, 'valid', jsonb_build_object('device', 'seed-scanner', 'location', 'Main Gate')),
        ($1, $3, 'duplicate', jsonb_build_object('device', 'seed-scanner', 'location', 'VIP Gate'))
    `,
    [eventId, guestsByStatus.scanned.id, guestsByStatus.confirmed.id],
  );

  const requestResult = await query(
    `
      INSERT INTO delivery_requests (
        organizer_id,
        event_id,
        guest_id,
        channel,
        template,
        payload,
        metadata,
        dedupe_key,
        current_status,
        attempt_count,
        last_provider_ref,
        last_error
      )
      VALUES (
        $1,
        $2,
        $3,
        'whatsapp',
        'event_invitation',
        jsonb_build_object('message', 'Bienvenido a Monotickets'),
        jsonb_build_object('seed', true),
        'seed',
        'sent',
        1,
        'seed-provider-ref',
        NULL
      )
      RETURNING id
    `,
    [
      '00000000-0000-0000-0000-000000000000',
      eventId,
      guestsByStatus.confirmed.id,
    ],
  );
  const requestId = requestResult.rows[0].id;

  await query(
    `
      INSERT INTO delivery_logs (
        request_id,
        attempt,
        status,
        provider_ref,
        error,
        metadata,
        is_free,
        session_id,
        queued_at,
        started_at,
        completed_at,
        created_at
      )
      VALUES (
        $1,
        1,
        'sent',
        'seed-provider-ref',
        NULL,
        jsonb_build_object('seed', true),
        true,
        $2,
        now() - interval '2 minutes',
        now() - interval '90 seconds',
        now() - interval '1 minute',
        now() - interval '2 minutes'
      )
    `,
    [requestId, seedSessions.confirmed || null],
  );

  logger({ level: 'info', message: 'db_seed_completed', event_id: eventId });
}

export async function initializeDatabase(options = {}) {
  const { env = process.env } = options;
  const logger = options.logger || createLogger({ env, service: env.SERVICE_NAME || 'backend-api' });

  await ensureExtensions(logger);
  await ensureCoreTables(logger);
  await ensureDeliveryInfrastructure(logger);
  await ensureLedgerTickets(logger);
  await seedBaselineData(logger);
}
