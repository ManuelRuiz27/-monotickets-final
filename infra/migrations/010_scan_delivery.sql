BEGIN;

CREATE TABLE IF NOT EXISTS scan_logs (
    id bigserial,
    event_id uuid NOT NULL,
    guest_id uuid NOT NULL,
    staff_id uuid,
    result text NOT NULL CHECK (result IN ('valid', 'duplicate', 'invalid')),
    ts timestamptz NOT NULL,
    device jsonb,
    PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

-- Particiones mensuales con formato scan_logs_YYYYMM.
DO $$
DECLARE
    month_start date;
    partition_start timestamptz;
    partition_end timestamptz;
    partition_name text;
BEGIN
    FOR month_start IN SELECT date_trunc('month', current_date + (offset_val * interval '1 month'))::date
        FROM generate_series(-1, 0) AS g(offset_val)
    LOOP
        partition_start := month_start;
        partition_end := (month_start + interval '1 month');
        partition_name := format('scan_logs_%s', to_char(month_start, 'YYYYMM'));

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF scan_logs FOR VALUES FROM (%L) TO (%L);',
            partition_name,
            partition_start,
            partition_end
        );
    END LOOP;
END $$;

-- Las particiones anteriores a 180 días deben eliminarse mediante un job de mantenimiento.

CREATE TABLE IF NOT EXISTS delivery_logs (
    id bigserial PRIMARY KEY,
    organizer_id uuid NOT NULL,
    event_id uuid,
    guest_id uuid,
    channel text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
    template text NOT NULL,
    status text NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
    is_free boolean NOT NULL DEFAULT false,
    provider_ref text,
    error jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
