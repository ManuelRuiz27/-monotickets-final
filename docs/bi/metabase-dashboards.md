# Dashboards sugeridos en Metabase

Las tarjetas demo permiten armar dos tableros base: uno operativo para organizadores y otro ejecutivo para dirección.

## 1. Organizer – Operación (live)

- **KPI tiles**
  - Confirmación hoy (`mv_confirmation_rate_daily` filtrado a `day = current_date`).
  - Show-up hoy (`mv_show_up_rate_daily` filtrado al día actual).
  - Ratio WA gratuito 24h (`mv_wa_free_ratio_daily`).
- **Series / gráficos**
  - Confirmación últimos 7 días (línea sobre `mv_confirmation_rate_daily`).
  - Escaneos por hora el día del evento (tabla/heatmap con `scan_logs` particionadas).
  - Tabla de invitados con drill-down: nombre, status, links (`invites.links->>'invite'`).
- **Filtros recomendados**: selector de evento, selector de organizador.

## 2. Director – Ejecutivo (90 días)

- **KPI tiles**
  - Mix de tipos (porcentaje de eventos `standard` vs `premium` usando `mv_event_mix_90d`).
  - Organizadores activos (conteo distinto de `organizer_id` con actividad en los últimos 90 días).
  - Deuda abierta (`mv_organizer_debt.open_debt`).
  - Top organizadores por tickets (tabla ordenada por `loan_tickets + prepaid_tickets`).
- **Series / gráficos**
  - Tendencia de confirmación (línea de `mv_confirmation_rate_daily` agregada por evento).
  - Evolución ratio WA gratuito (línea de `mv_wa_free_ratio_daily`).
  - Aging de deuda: buckets por antigüedad usando `payments.last_payment_at` y `mv_organizer_debt`.
- **Notas**
  - Documenta que `is_free` proviene de la sesión activa (`wa_sessions`) y enlaza con `delivery_logs.session_id` para trazabilidad.
  - Resalta las equivalencias de tickets (`ticket_ledger.equiv_json`) para alinear precios estándar vs premium.
