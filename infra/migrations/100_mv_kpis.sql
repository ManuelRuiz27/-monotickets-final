BEGIN;

DROP MATERIALIZED VIEW IF EXISTS mv_confirmation_rate_daily;
CREATE MATERIALIZED VIEW mv_confirmation_rate_daily AS
SELECT e.id AS event_id,
       date(g.created_at) AS day,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE g.status = 'confirmed') AS confirmed,
       ROUND(100.0 * COUNT(*) FILTER (WHERE g.status = 'confirmed') / NULLIF(COUNT(*), 0), 2) AS confirmation_rate
FROM guests g
JOIN events e ON e.id = g.event_id
GROUP BY e.id, day;

DROP MATERIALIZED VIEW IF EXISTS mv_show_up_rate_daily;
CREATE MATERIALIZED VIEW mv_show_up_rate_daily AS
SELECT e.id AS event_id,
       date(s.ts) AS day,
       COUNT(DISTINCT g.id) FILTER (WHERE g.status = 'confirmed') AS confirmed,
       COUNT(DISTINCT s.guest_id) FILTER (WHERE s.result = 'valid') AS scanned,
       ROUND(
           100.0 * COUNT(DISTINCT s.guest_id) FILTER (WHERE s.result = 'valid') /
           NULLIF(COUNT(DISTINCT g.id) FILTER (WHERE g.status = 'confirmed'), 0),
           2
       ) AS show_up_rate
FROM scan_logs s
JOIN guests g ON s.guest_id = g.id
JOIN events e ON e.id = g.event_id
GROUP BY e.id, day;

DROP MATERIALIZED VIEW IF EXISTS mv_wa_free_ratio_daily;
CREATE MATERIALIZED VIEW mv_wa_free_ratio_daily AS
SELECT e.id AS event_id,
       date(d.created_at) AS day,
       COUNT(*) FILTER (WHERE d.channel = 'whatsapp') AS total_wa,
       COUNT(*) FILTER (WHERE d.channel = 'whatsapp' AND d.is_free) AS free_wa,
       ROUND(
           100.0 * COUNT(*) FILTER (WHERE d.channel = 'whatsapp' AND d.is_free) /
           NULLIF(COUNT(*) FILTER (WHERE d.channel = 'whatsapp'), 0),
           2
       ) AS wa_free_ratio
FROM delivery_logs d
JOIN events e ON e.id = d.event_id
GROUP BY e.id, day;

DROP MATERIALIZED VIEW IF EXISTS mv_event_mix_90d;
CREATE MATERIALIZED VIEW mv_event_mix_90d AS
SELECT date_trunc('day', e.created_at) AS day,
       e.type,
       COUNT(DISTINCT e.id) AS events_count,
       COUNT(g.id) AS guests_count
FROM events e
LEFT JOIN guests g ON g.event_id = e.id
WHERE e.created_at >= now() - interval '90 days'
GROUP BY day, e.type;

DROP MATERIALIZED VIEW IF EXISTS mv_organizer_debt;
CREATE MATERIALIZED VIEW mv_organizer_debt AS
WITH ledger_totals AS (
    SELECT organizer_id,
           SUM(CASE WHEN kind = 'prepago' THEN tickets END) AS prepaid_tickets,
           SUM(CASE WHEN kind = 'prestamo' THEN tickets END) AS loan_tickets,
           SUM(CASE WHEN kind = 'prestamo' THEN tickets * unit_price ELSE 0 END) AS loan_value
    FROM ticket_ledger
    GROUP BY organizer_id
),
payment_totals AS (
    SELECT organizer_id,
           SUM(amount) AS payments_total,
           MAX(created_at) AS last_payment_at
    FROM payments
    GROUP BY organizer_id
)
SELECT o.id AS organizer_id,
       (COALESCE(lt.loan_value, 0) - COALESCE(pt.payments_total, 0)) AS open_debt,
       COALESCE(lt.prepaid_tickets, 0) AS prepaid_tickets,
       COALESCE(lt.loan_tickets, 0) AS loan_tickets,
       pt.last_payment_at
FROM organizers o
LEFT JOIN ledger_totals lt ON lt.organizer_id = o.id
LEFT JOIN payment_totals pt ON pt.organizer_id = o.id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_confirmation_rate_daily_idx
    ON mv_confirmation_rate_daily (event_id, day);
CREATE UNIQUE INDEX IF NOT EXISTS mv_show_up_rate_daily_idx
    ON mv_show_up_rate_daily (event_id, day);
CREATE UNIQUE INDEX IF NOT EXISTS mv_wa_free_ratio_daily_idx
    ON mv_wa_free_ratio_daily (event_id, day);
CREATE UNIQUE INDEX IF NOT EXISTS mv_event_mix_90d_idx
    ON mv_event_mix_90d (day, type);
CREATE UNIQUE INDEX IF NOT EXISTS mv_organizer_debt_idx
    ON mv_organizer_debt (organizer_id);

COMMIT;

REFRESH MATERIALIZED VIEW CONCURRENTLY mv_confirmation_rate_daily;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_show_up_rate_daily;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_wa_free_ratio_daily;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_event_mix_90d;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_organizer_debt;
