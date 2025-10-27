# KPIs Materializados

Las vistas materializadas (`mv_*`) se crean en `infra/migrations/100_mv_kpis.sql` y se refrescan vía `pg_cron` (ver `110_pg_cron_refresh.sql`). Cada KPI se diseñó para soportar `REFRESH MATERIALIZED VIEW CONCURRENTLY` sin bloquear consultas.

## 1. Tasa de confirmación diaria (`mv_confirmation_rate_daily`)
- **Definición**: `confirmados / total invitados` por `event_id`, `event_type` y día (`date_trunc('day', guests.created_at)`).
- **Inputs**: `guests` + `events`.
- **Notas**: considera como confirmados a los invitados con `status IN ('confirmed','scanned')`.

## 2. Show-up rate diario (`mv_show_up_rate_daily`)
- **Definición**: `escaneados válidos / confirmados` por `event_id` y día (`date_trunc('day', scan_logs.ts)`).
- **Inputs**: `scan_logs` (solo `result='valid'`) + `guests`.
- **Notas**: `scanned` cuenta invitados únicos válidos por día; el denominador toma los invitados confirmados actuales del evento.

## 3. Ratio de sesiones gratuitas de WhatsApp (`mv_wa_free_ratio_daily`)
- **Definición**: `sesiones_gratuitas / total_mensajes_whatsapp` por `event_id` y día (`delivery_logs.created_at`).
- **Inputs**: `delivery_logs` filtrado por `channel='whatsapp'` y `status IN ('sent','delivered')`, tomando la bandera `is_free` y los enlaces `session_id`.
- **Notas**: `session_id` enlaza cada intento con `wa_sessions`, eliminando heurísticas previas y permitiendo auditar si cada mensaje cayó dentro de una sesión abierta.

### Tabla de soporte `wa_sessions`

- **Propósito**: persistir la ventana activa de 24 h para cada número normalizado de WhatsApp.
- **Columnas clave**:
  - `phone`: número E.164 sin caracteres especiales (único por fila).
  - `started_at` / `expires_at`: delimitan la ventana elegible para enviar mensajes gratuitos.
  - `last_message_at`: referencia del último inbound o outbound que renovó la sesión.
  - `metadata`: JSON para anotar el contexto (`guest_id`, `event_id`, etiquetas de seed, etc.).
  - `created_at` / `updated_at`: trazan la vigencia y facilitan depuración.
- **Relación con `delivery_logs`**:
  - `delivery_logs.session_id` apunta al registro de `wa_sessions` vigente cuando se intentó el envío.
  - `delivery_logs.is_free` se marca en `true` solo cuando existe una sesión activa al momento de crear el intento, dejando rastro contable cuando se factura un mensaje fuera de ventana.
  - Las vistas `mv_wa_free_ratio_daily` y `mv_kpi_wa_sessions_ratio` contabilizan ambos campos para análisis operativos y ejecutivos.

## 4. Mix de eventos 90 días (`mv_event_mix_90d`)
- **Definición**: conteo de eventos y de invitados por tipo (`standard|premium`) y día (`date_trunc('day', events.starts_at)`) en una ventana rodante de 90 días.
- **Inputs**: `events`, `guests`.
- **Uso**: alimenta dashboards ejecutivos para comparar proporciones de eventos standard/premium.

## 5. Deuda abierta por organizador (`mv_organizer_debt`)
- **Definición**: `sum(préstamos abiertos * precio unitario) − sum(pagos)` con columnas adicionales para `prepaid_tickets`, `loan_tickets` y `last_payment_at`.
- **Inputs**: `ticket_ledger`, `payments`, `organizers`.
- **Notas**: los prepago reducen la deuda (al convertirse en saldo a favor), los préstamos generan deuda abierta hasta que se registren pagos.

## Refresco y orquestación
- **`pg_cron` disponible**: la migración `110_pg_cron_refresh.sql` agenda refrescos cada 5 minutos (KPIs operativos), 10 minutos (WhatsApp) y 60 minutos (dashboards ejecutivos).
- **Sin `pg_cron`**: levanta un worker (Node/TS) conectado a la misma base para ejecutar periódicamente `REFRESH MATERIALIZED VIEW CONCURRENTLY ...` con un backoff (ej. usar la cola existente documentada en `ADR` de VM-Workers). Mantén los intervalos sugeridos arriba.

## Particiones de `scan_logs` y `delivery_logs`
El worker de backend agenda automáticamente un job diario (`runLogPartitionMaintenanceJob`) que:

- Verifica que existan particiones para el mes anterior, el actual y el siguiente.
- Crea de forma anticipada la partición del siguiente mes (por defecto 5 días antes de iniciar el mes, configurable con `SCAN_LOG_PARTITION_LEAD_DAYS`, `SCAN_LOG_PARTITION_HOUR` y `SCAN_LOG_PARTITION_MINUTE`).
- Elimina particiones completas más antiguas que `SCAN_LOG_RETENTION_DAYS` (valor permitido entre 90 y 180 días; default 180).

El job escribe en logs cada creación/eliminación y emite un mensaje de error (`log_partition_missing` o `log_partition_missing_after_attempt`) cuando detecta particiones faltantes para los meses requeridos.

Consulta `docs/db/README.md` para ver la tabla completa de variables (`SCAN_LOG_*`) y pasos de verificación. Para ejecuciones manuales existe el script `backend/scripts/cleanup-log-partitions.js` que reutiliza la misma lógica; acepta la bandera `--dry-run` para validar sin aplicar cambios.
