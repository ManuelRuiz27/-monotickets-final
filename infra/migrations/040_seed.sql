WITH constants AS (
    SELECT
        date_trunc('month', now()) AS current_month_start,
        date_trunc('month', now()) - interval '1 month' AS previous_month_start
),
organizer_seed AS (
    INSERT INTO organizers (name, contact, pricing, status, billing, tags, account_manager)
    VALUES
        (
            'Experiencias Aurora',
            jsonb_build_object('email', 'contacto@aurora.mx', 'phone', '+52-55-1000-0001'),
            jsonb_build_object('standard_ticket_price', 5.00, 'premium_ticket_price', 9.50),
            'active',
            jsonb_build_object('tax_id', 'EAU901220MM0', 'invoice_email', 'billing@aurora.mx'),
            ARRAY['premium', 'hospitality']::text[],
            'mx-mariana.rios'
        ),
        (
            'Momentum Eventos',
            jsonb_build_object('email', 'hola@momentum.mx', 'phone', '+52-33-9000-0002'),
            jsonb_build_object('standard_ticket_price', 3.50, 'premium_ticket_price', 7.50),
            'active',
            jsonb_build_object('tax_id', 'MON830102AA1', 'invoice_email', 'finance@momentum.mx'),
            ARRAY['corporate', 'hybrid']::text[],
            'mx-andres.lopez'
        ),
        (
            'Cumbre Boreal',
            jsonb_build_object('email', 'hello@cumbreboreal.mx', 'phone', '+52-81-4020-1003'),
            jsonb_build_object('standard_ticket_price', 4.20, 'premium_ticket_price', 8.10),
            'active',
            jsonb_build_object('tax_id', 'CBO770101BB2', 'invoice_email', 'cobranza@cumbreboreal.mx'),
            ARRAY['outdoor', 'hybrid']::text[],
            'mx-ana.luna'
        ),
        (
            'Luminaria Producciones',
            jsonb_build_object('email', 'info@luminaria.mx', 'phone', '+52-55-4020-1004'),
            jsonb_build_object('standard_ticket_price', 6.10, 'premium_ticket_price', 11.20),
            'active',
            jsonb_build_object('tax_id', 'LUP850202CC3', 'invoice_email', 'billing@luminaria.mx'),
            ARRAY['premium', 'concerts']::text[],
            'mx-marco.solis'
        ),
        (
            'Atlántico Booking',
            jsonb_build_object('email', 'ventas@atlantico.mx', 'phone', '+52-229-330-1005'),
            jsonb_build_object('standard_ticket_price', 2.80, 'premium_ticket_price', 5.40),
            'suspended',
            jsonb_build_object('tax_id', 'ATB930303DD4', 'invoice_email', 'pagos@atlantico.mx'),
            ARRAY['corporate']::text[],
            'mx-laura.vera'
        ),
        (
            'Ruta Norte Eventos',
            jsonb_build_object('email', 'contacto@rutanorte.mx', 'phone', '+52-81-7777-1006'),
            jsonb_build_object('standard_ticket_price', 3.90, 'premium_ticket_price', 7.80),
            'active',
            jsonb_build_object('tax_id', 'RNE910404EE5', 'invoice_email', 'cobros@rutanorte.mx'),
            ARRAY['regional', 'standard']::text[],
            'mx-isaac.marin'
        ),
        (
            'Selva & Co',
            jsonb_build_object('email', 'hola@selva.mx', 'phone', '+52-55-6600-1007'),
            jsonb_build_object('standard_ticket_price', 2.60, 'premium_ticket_price', 5.80),
            'active',
            jsonb_build_object('tax_id', 'SEL950505FF6', 'invoice_email', 'finanzas@selva.mx'),
            ARRAY['eco', 'hybrid']::text[],
            'mx-valeria.rojas'
        ),
        (
            'Distrito Sonoro',
            jsonb_build_object('email', 'hello@distritosonoro.mx', 'phone', '+52-33-4400-1008'),
            jsonb_build_object('standard_ticket_price', 4.80, 'premium_ticket_price', 9.20),
            'active',
            jsonb_build_object('tax_id', 'DIS890606GG7', 'invoice_email', 'billing@distritosonoro.mx'),
            ARRAY['concerts', 'urban']::text[],
            'mx-saul.mendez'
        ),
        (
            'Foro Prisma',
            jsonb_build_object('email', 'info@foroprisma.mx', 'phone', '+52-55-7800-1009'),
            jsonb_build_object('standard_ticket_price', 3.10, 'premium_ticket_price', 6.30),
            'archived',
            jsonb_build_object('tax_id', 'FPR870707HH8', 'invoice_email', 'cierre@foroprisma.mx'),
            ARRAY['venue']::text[],
            'mx-alejandra.tez'
        ),
        (
            'Andes Summit',
            jsonb_build_object('email', 'coord@andessummit.pe', 'phone', '+51-1-220-1010'),
            jsonb_build_object('standard_ticket_price', 5.50, 'premium_ticket_price', 10.40),
            'active',
            jsonb_build_object('tax_id', 'AND990808JJ9', 'invoice_email', 'billing@andessummit.pe'),
            ARRAY['conference', 'international']::text[],
            'pe-nicolas.quispe'
        )
    RETURNING id, name, pricing
),
event_seed AS (
    INSERT INTO events (organizer_id, name, type, status, starts_at, ends_at)
    VALUES
        (
            (SELECT id FROM organizer_seed WHERE name = 'Experiencias Aurora'),
            'Gala Innovación 2024',
            'standard',
            'active',
            date_trunc('hour', now() - interval '10 days') + interval '18 hours',
            date_trunc('hour', now() - interval '9 days') + interval '2 hours'
        ),
        (
            (SELECT id FROM organizer_seed WHERE name = 'Momentum Eventos'),
            'Summit Premium Riviera',
            'premium',
            'active',
            date_trunc('hour', now() + interval '15 days') + interval '10 hours',
            date_trunc('hour', now() + interval '15 days') + interval '18 hours'
        )
    RETURNING id, organizer_id, type, name, starts_at
),
event_enriched AS (
    SELECT
        es.*,
        ROW_NUMBER() OVER (ORDER BY es.starts_at) AS event_idx
    FROM event_seed es
),
guest_blueprint AS (
    SELECT
        e.id AS event_id,
        e.organizer_id,
        e.type,
        e.name AS event_name,
        gs AS guest_seq,
        CASE
            WHEN gs <= 4 THEN 'pending'
            WHEN gs <= 8 THEN 'confirmed'
            ELSE 'scanned'
        END AS status,
        CASE
            WHEN gs > 4 THEN
                jsonb_build_object(
                    'channel', CASE WHEN gs % 2 = 0 THEN 'whatsapp' ELSE 'email' END,
                    'confirmed_at', now() - (gs * interval '1 day')
                )
            ELSE NULL
        END AS confirmation_payload,
        format('%s Invitado %s', e.name, gs) AS guest_name,
        '+52' || lpad((55 + e.event_idx)::text, 2, '0') || lpad(gs::text, 2, '0') || lpad((gs * 7)::text, 4, '0') AS phone,
        lower(replace(e.name, ' ', '.')) || '.guest' || gs || '@demo.monotickets.mx' AS email
    FROM event_enriched e
    CROSS JOIN generate_series(1, 16) AS gs
),
guest_insert AS (
    INSERT INTO guests (event_id, name, phone, email, status, confirmation_payload)
    SELECT event_id, guest_name, phone, email, status, confirmation_payload
    FROM guest_blueprint
    RETURNING *
),
guest_enriched AS (
    SELECT
        gi.*,
        gb.guest_seq,
        gb.event_name,
        gb.type AS event_type,
        gb.organizer_id
    FROM guest_insert gi
    JOIN guest_blueprint gb
      ON gb.event_id = gi.event_id AND gb.email = gi.email
),
invite_payload AS (
    SELECT
        g.event_id,
        g.id AS guest_id,
        CONCAT('MT-', upper(encode(gen_random_bytes(4), 'hex'))) AS code
    FROM guest_enriched g
),
invite_insert AS (
    INSERT INTO invites (event_id, guest_id, code, links)
    SELECT
        event_id,
        guest_id,
        code,
        jsonb_build_object(
            'invite', format('/public/invite/%s', code),
            'confirm', format('/public/confirm/%s', code),
            'pdf', format('/public/invite/%s.pdf', code)
        )
    FROM invite_payload
    RETURNING *
),
scanned_guests AS (
    SELECT
        g.id,
        g.event_id,
        g.guest_seq,
        ROW_NUMBER() OVER (PARTITION BY g.event_id ORDER BY g.created_at) AS rn
    FROM guest_enriched g
    WHERE g.status = 'scanned'
),
valid_scans AS (
    INSERT INTO scan_logs (event_id, guest_id, result, ts, device)
    SELECT
        sg.event_id,
        sg.id AS guest_id,
        'valid',
        CASE
            WHEN e.event_idx = 1 AND attempt = 1 THEN
                c.previous_month_start + ((sg.rn % 10) * interval '1 day') + (attempt * interval '25 minutes')
            ELSE
                c.current_month_start + ((sg.rn % 12) * interval '1 day') + (attempt * interval '20 minutes')
        END AS ts,
        jsonb_build_object(
            'device_id', concat('scanner-', left(sg.event_id::text, 8)),
            'location', CASE WHEN sg.rn % 2 = 0 THEN 'Main Gate' ELSE 'VIP Gate' END
        )
    FROM scanned_guests sg
    JOIN event_enriched e ON e.id = sg.event_id
    CROSS JOIN constants c
    CROSS JOIN generate_series(1, 2) AS attempt
    RETURNING 1
),
duplicate_scans AS (
    INSERT INTO scan_logs (event_id, guest_id, result, ts, device)
    SELECT
        sg.event_id,
        sg.id AS guest_id,
        'duplicate',
        CASE
            WHEN e.event_idx = 1 THEN
                c.current_month_start + ((sg.guest_seq % 6) * interval '2 days') + (dup.iteration * interval '5 minutes')
            ELSE
                c.current_month_start + ((sg.guest_seq % 8) * interval '1 day') + (dup.iteration * interval '4 minutes')
        END AS ts,
        jsonb_build_object(
            'device_id', concat('scanner-', left(sg.event_id::text, 8)),
            'location', CASE WHEN sg.rn % 3 = 0 THEN 'Secondary Gate' ELSE 'Main Gate' END
        )
    FROM scanned_guests sg
    JOIN event_enriched e ON e.id = sg.event_id
    CROSS JOIN constants c
    JOIN LATERAL generate_series(1, 3) AS dup(iteration) ON TRUE
    RETURNING 1
),
invalid_scans AS (
    INSERT INTO scan_logs (event_id, guest_id, result, ts, device)
    SELECT
        g.event_id,
        g.id,
        'invalid',
        CASE
            WHEN g.guest_seq % 2 = 0 THEN
                c.previous_month_start + interval '12 days' - (attempt.iteration * interval '30 minutes')
            ELSE
                c.current_month_start + interval '3 days' - (attempt.iteration * interval '20 minutes')
        END,
        jsonb_build_object('device_id', 'scanner-reject', 'location', 'Service Desk')
    FROM guest_enriched g
    CROSS JOIN constants c
    JOIN LATERAL generate_series(1, 2) AS attempt(iteration) ON TRUE
    WHERE g.status = 'pending'
    RETURNING 1
),
confirmed_guests AS (
    SELECT g.*, e.event_idx
    FROM guest_enriched g
    JOIN event_enriched e ON e.id = g.event_id
    WHERE g.status IN ('confirmed', 'scanned')
),
wa_session_seed AS (
    INSERT INTO wa_sessions (phone, started_at, expires_at, metadata, last_message_at)
    SELECT DISTINCT
        regexp_replace(g.phone, '\\D', '', 'g') AS phone,
        now() - interval '2 hours' + (g.guest_seq * interval '10 minutes') AS started_at,
        now() + interval '20 hours' - (g.guest_seq * interval '5 minutes') AS expires_at,
        jsonb_build_object('seed', true, 'guest_id', g.id, 'event_id', g.event_id) AS metadata,
        now() - interval '30 minutes' AS last_message_at
    FROM guest_enriched g
    WHERE g.status IN ('confirmed', 'pending')
    ON CONFLICT (phone) DO UPDATE
      SET started_at = EXCLUDED.started_at,
          expires_at = EXCLUDED.expires_at,
          metadata = jsonb_strip_nulls(wa_sessions.metadata || EXCLUDED.metadata),
          last_message_at = EXCLUDED.last_message_at,
          updated_at = now()
    RETURNING id, phone
),
delivery_plan AS (
    SELECT
        e.organizer_id,
        g.event_id,
        g.id AS guest_id,
        regexp_replace(g.phone, '\\D', '', 'g') AS normalized_phone,
        CASE WHEN (g.guest_seq + attempt.attempt) % 2 = 0 THEN 'whatsapp' ELSE 'email' END AS channel,
        CASE
            WHEN (g.guest_seq + attempt.attempt) % 3 = 0 THEN 'reminder_template'
            WHEN (g.guest_seq + attempt.attempt) % 2 = 0 THEN 'session_followup'
            ELSE 'initial_invite'
        END AS template,
        attempt.attempt AS attempt,
        CASE
            WHEN (g.guest_seq + attempt.attempt) % 7 = 0 THEN 'failed'
            WHEN (g.guest_seq + attempt.attempt) % 5 = 0 THEN 'queued'
            WHEN (g.guest_seq + attempt.attempt) % 3 = 0 THEN 'sent'
            ELSE 'delivered'
        END AS status,
        concat('ref-', upper(encode(gen_random_bytes(3), 'hex'))) AS provider_ref,
        now() - ((g.guest_seq + attempt.attempt) * interval '6 hours') AS created_at,
        CASE
            WHEN (g.guest_seq + attempt.attempt) % 7 = 0 THEN jsonb_build_object('code', 'WA-400', 'message', 'Outside 24h window')
            ELSE NULL
        END AS error
    FROM confirmed_guests g
    JOIN event_enriched e ON e.id = g.event_id
    JOIN LATERAL generate_series(1, 4) AS attempt(attempt) ON TRUE
),
delivery_insert AS (
    INSERT INTO delivery_logs (organizer_id, event_id, guest_id, channel, template, status, is_free, session_id, provider_ref, metadata, error, created_at, updated_at)
    SELECT
        dp.organizer_id,
        dp.event_id,
        dp.guest_id,
        dp.channel,
        dp.template,
        dp.status,
        CASE
            WHEN dp.channel = 'whatsapp'
                 AND ws.id IS NOT NULL
                 AND dp.created_at >= now() - interval '24 hours'
            THEN true
            ELSE false
        END AS is_free,
        ws.id AS session_id,
        dp.provider_ref,
        jsonb_build_object('seed', true, 'attempt', dp.attempt),
        dp.error,
        dp.created_at,
        CASE WHEN dp.status = 'queued' THEN dp.created_at ELSE dp.created_at + interval '15 minutes' END
    FROM delivery_plan dp
    LEFT JOIN wa_session_seed ws ON ws.phone = dp.normalized_phone
    RETURNING *
),
wa_ratio_source AS (
    SELECT
        ge.organizer_id,
        ge.event_id,
        ge.id AS guest_id,
        ws.id AS session_id
    FROM guest_enriched ge
    JOIN wa_session_seed ws
      ON ws.phone = regexp_replace(ge.phone, '\\D', '', 'g')
    WHERE ge.status IN ('confirmed', 'pending')
    ORDER BY ge.guest_seq
    LIMIT 1
),
wa_ratio_samples AS (
    SELECT
        src.organizer_id,
        src.event_id,
        src.guest_id,
        src.session_id,
        sample.seq,
        sample.is_free,
        sample.status,
        date_trunc('day', now()) + interval '8 hours' + (sample.seq * interval '30 minutes') AS created_at
    FROM wa_ratio_source src
    JOIN LATERAL (
        VALUES
            (0, true, 'delivered'),
            (1, true, 'sent'),
            (2, false, 'delivered'),
            (3, false, 'failed'),
            (4, true, 'queued')
    ) AS sample(seq, is_free, status) ON TRUE
),
wa_ratio_seed AS (
    INSERT INTO delivery_logs (organizer_id, event_id, guest_id, channel, template, status, is_free, session_id, provider_ref, metadata, error, created_at, updated_at)
    SELECT
        sample.organizer_id,
        sample.event_id,
        sample.guest_id,
        'whatsapp' AS channel,
        CASE WHEN sample.seq % 2 = 0 THEN 'session_followup' ELSE 'wa_ratio_probe' END AS template,
        sample.status,
        sample.is_free,
        CASE WHEN sample.is_free THEN sample.session_id ELSE NULL END AS session_id,
        format('wa-ratio-%s', sample.seq) AS provider_ref,
        jsonb_build_object('seed', true, 'ratio_seq', sample.seq) AS metadata,
        NULL::jsonb AS error,
        sample.created_at,
        sample.created_at + interval '15 minutes' AS updated_at
    FROM wa_ratio_samples sample
    RETURNING *
),
ledger_blueprint AS (
    SELECT
        o.id AS organizer_id,
        o.name AS organizer_name,
        CASE
            WHEN o.name IN ('Experiencias Aurora', 'Momentum Eventos') THEN
                (SELECT id FROM event_enriched e WHERE e.organizer_id = o.id LIMIT 1)
            ELSE NULL
        END AS event_id,
        CASE WHEN series.seq % 2 = 0 THEN 'prepago' ELSE 'prestamo' END AS kind,
        ROW_NUMBER() OVER (PARTITION BY o.id ORDER BY series.seq) AS rn,
        series.seq,
        (o.pricing->>'standard_ticket_price')::numeric AS standard_price
    FROM organizer_seed o
    JOIN LATERAL generate_series(
        1,
        CASE WHEN o.name IN ('Experiencias Aurora', 'Momentum Eventos') THEN 4 ELSE 3 END
    ) AS series(seq) ON TRUE
),
ledger_insert AS (
    INSERT INTO ticket_ledger (organizer_id, event_id, kind, tickets, equiv_json, unit_price, source, reference, metadata)
    SELECT
        organizer_id,
        event_id,
        kind,
        90 + rn * 10 AS tickets,
        jsonb_build_object(
            'standard_equiv', 90 + rn * 10,
            'premium_equiv', CEIL((90 + rn * 10) * 0.5),
            'ratio', jsonb_build_object('standard', 1, 'premium', 2)
        ) AS equiv_json,
        standard_price AS unit_price,
        CASE
            WHEN seq % 3 = 0 THEN 'adjustment'
            WHEN seq % 2 = 0 THEN 'import'
            ELSE 'manual'
        END AS source,
        substr(organizer_id::text, 1, 6) || '-' || to_char(seq, 'FM00') AS reference,
        jsonb_build_object(
            'batch', rn,
            'season', CASE WHEN seq % 2 = 0 THEN 'spring' ELSE 'summer' END,
            'organizer', organizer_name
        ) AS metadata
    FROM ledger_blueprint
    RETURNING *
),
payments_blueprint AS (
    SELECT
        o.id AS organizer_id,
        o.name AS organizer_name,
        ROW_NUMBER() OVER (PARTITION BY o.id ORDER BY series.seq) AS rn,
        series.seq
    FROM organizer_seed o
    JOIN LATERAL generate_series(
        1,
        CASE WHEN o.name IN ('Experiencias Aurora', 'Momentum Eventos') THEN 4 ELSE 2 END
    ) AS series(seq) ON TRUE
),
payments_insert AS (
    INSERT INTO payments (organizer_id, amount, method, ref, status, processed_at, metadata)
    SELECT
        organizer_id,
        ROUND((150 + rn * 25 + seq * 5)::numeric, 2) AS amount,
        CASE WHEN seq % 2 = 0 THEN 'spei' ELSE 'transferencia' END AS method,
        upper(left(regexp_replace(organizer_name, '[^A-Za-z]', '', 'g'), 3)) || '-' ||
            to_char(700 + rn * 10 + seq, 'FM0000') AS ref,
        CASE
            WHEN seq % 4 = 0 THEN 'failed'
            WHEN seq % 3 = 0 THEN 'pending'
            ELSE 'settled'
        END AS status,
        now() - (rn * interval '4 days') - (seq * interval '6 hours') AS processed_at,
        jsonb_build_object(
            'batch', rn,
            'channel', CASE WHEN seq % 2 = 0 THEN 'bank' ELSE 'cash' END,
            'imported', seq % 3 = 0
        ) AS metadata
    FROM payments_blueprint
    RETURNING *
)
SELECT
    (SELECT COUNT(*) FROM organizer_seed) AS organizers_inserted,
    (SELECT COUNT(*) FROM event_seed) AS events_inserted,
    (SELECT COUNT(*) FROM guest_insert) AS guests_inserted,
    (SELECT COUNT(*) FROM invite_insert) AS invites_inserted,
    (SELECT COUNT(*) FROM delivery_insert) AS delivery_logs_inserted,
    (SELECT COUNT(*) FROM wa_ratio_seed) AS wa_ratio_samples,
    (SELECT COUNT(*) FROM scan_logs) AS total_scan_logs,
    (SELECT COUNT(*) FROM ledger_insert) AS ledger_rows,
    (SELECT COUNT(*) FROM payments_insert) AS payments_rows;
