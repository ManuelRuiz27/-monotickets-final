# Servicio Director

El servicio Director expone los flujos financieros de Monotickets para administrar tickets asignados a organizadores, registrar pagos y consultar métricas agregadas.

## Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/director/assign` | Registra una asignación de tickets prepago o préstamo. Requiere `organizerId`, `eventId`, `type` (`prepaid`/`loan`), `tickets` y `price`. |
| `GET` | `/director/organizers/:id/ledger` | Devuelve el historial de movimientos del organizador, incluyendo totales y saldo. |
| `POST` | `/director/payments` | Registra un pago recibido y descuenta la deuda abierta del organizador. |
| `GET` | `/director/reports/overview` | Métricas globales (tickets equivalentes, deuda, pagos) con filtros `from`, `to`, `status`, `organizerId`, `eventId`. |
| `GET` | `/director/reports/top-organizers` | Ranking de organizadores por tickets equivalentes. Soporta filtros estándar y paginación `page`, `pageSize`, `sort`, `dir`, `limit`. |
| `GET` | `/director/reports/debt-aging` | Distribución de deuda por tramos (`0–30`, `31–60`, `61–90`, `>90` días). |
| `GET` | `/director/reports/tickets-usage` | Uso de tickets por evento (`standard`/`premium`). Acepta `eventType`, `organizerId`, `from`, `to` y paginación. |

El endpoint heredado `/director/overview` sigue disponible y ahora consulta las vistas materializadas descritas abajo.

## Modelo de tickets equivalentes

Cada evento define su tipo (`standard` o `premium`). El factor de conversión se controla con `TICKET_PREMIUM_FACTOR` (por defecto 2). Se calcula:

```
tickets_equivalentes = tickets_asignados * (event.type === 'premium' ? TICKET_PREMIUM_FACTOR : 1)
```

Los movimientos almacenan tanto los tickets sin conversión como los equivalentes para facilitar los KPIs.

## Ledger y movimientos

Las asignaciones y pagos se guardan en `director_ledger_entries`.

- `entry_type`: `assign_prepaid`, `assign_loan` o `payment`.
- `tickets` y `tickets_equivalent` para medir inventario.
- `amount_cents` y `currency` para calcular deuda y pagos.
- `metadata` con detalles extra (ej. plantilla, notas).

El ledger se puede consultar por organizador con paginación simple (ordenado por `created_at` descendente). El servicio calcula, en tiempo real, el saldo pendiente como:

```
deuda = sum(asignaciones.amount_cents) - sum(pagos.amount_cents)
```

## KPIs y vistas materializadas

Se crearon las siguientes vistas:

- `mv_kpi_tickets_entregados`: total de tickets equivalentes entregados por organizador y evento.
- `mv_kpi_deuda_abierta`: deuda pendiente (`amount_cents`) por organizador.
- `mv_kpi_top_organizadores`: ranking de organizadores por tickets equivalentes entregados.

El script `docs/db/migrations/refresh_kpis.sql` ejecuta `REFRESH MATERIALIZED VIEW CONCURRENTLY` para las tres vistas. Se recomienda correrlo desde el contenedor de base de datos o con `psql` en ambientes QA/producción.

## Reportes avanzados

Los endpoints del dashboard consumen las vistas materializadas y respetan filtros estándar:

- `from`, `to`: fechas `YYYY-MM-DD` para filtrar por `created_at`.
- `status`: lista separada por comas. Para `overview` se reconocen `pending|confirmed|scanned` (invitados) y `queued|sent|delivered|failed` (delivery).
- `organizerId`, `eventId`, `eventType` (`standard`/`premium`).
- `page`, `pageSize`, `sort` (`created_at|amount|tickets`) y `dir` (`asc|desc`).

### `/director/reports/overview`

Respuesta:

```json
{
  "meta": {
    "from": "2025-10-01",
    "to": "2025-10-31",
    "page": 1,
    "pageSize": 1,
    "generatedAt": "2025-11-01T03:00:00.000Z"
  },
  "data": [
    { "metric": "ticketsEquivalentDelivered", "value": 4200 },
    { "metric": "assignedValueCents", "value": 985000 },
    { "metric": "openDebtCents", "value": 125000 },
    { "metric": "activeOrganizers", "value": 18 },
    { "metric": "paymentsAppliedCents", "value": 860000 },
    { "metric": "guestsByStatus", "breakdown": [{ "status": "confirmed", "count": 320 }] },
    { "metric": "deliveriesByStatus", "breakdown": [{ "status": "delivered", "count": 2800 }] }
  ]
}
```

### `/director/reports/top-organizers`

Ejemplo:

```bash
curl -s "http://localhost:8080/director/reports/top-organizers?from=2025-10-01&to=2025-10-31&page=1&pageSize=5&sort=tickets&dir=desc"
```

Cada elemento de `data[]` contiene `organizerId`, `ticketsEquivalent`, `assignedValueCents` y `lastActivityAt`. El `meta` incluye `total` y `pages` para paginación.

### `/director/reports/debt-aging`

Retorna la deuda abierta agrupada en tramos de días. Ejemplo de `data`:

```json
[
  { "bucket": "0-30", "amountCents": 350000, "count": 12 },
  { "bucket": "31-60", "amountCents": 210000, "count": 6 },
  { "bucket": "61-90", "amountCents": 95000, "count": 3 },
  { "bucket": ">90", "amountCents": 180000, "count": 4 }
]
```

### `/director/reports/tickets-usage`

Permite analizar asignaciones por evento. Soporta `eventType=standard|premium` para distinguir conversiones.

```bash
curl -s "http://localhost:8080/director/reports/tickets-usage?eventType=premium&from=2025-09-01&to=2025-10-31&page=1&pageSize=10&sort=created_at"
```

Cada fila incluye `eventId`, `eventName`, `eventType`, `ticketsAssigned`, `ticketsEquivalent`, `assignedValueCents` y `lastMovementAt`.

## Cache y TTL

El overview financiero (`/director/overview`) se almacena en Redis por 30–60 s (`DIRECTOR_CACHE_TTL_SECONDS`). Los reportes avanzados usan claves independientes (`DIRECTOR_REPORT_CACHE_TTL_SECONDS`) con TTL corto (30–60 s). Cualquier asignación o pago invalida todas las claves (`director:overview`, `director:reports:*`). El worker `runKpiRefreshJob` refresca las vistas materializadas y precalienta la caché durante la madrugada.

## Reportes como trabajos asíncronos

Los reportes pesados (ej. exportaciones CSV, tendencias históricas de varios meses) deben procesarse como trabajos en la cola de workers para evitar timeouts del API síncrono.

1. **Solicitud inicial.** El endpoint (por ejemplo `POST /director/reports/exports`) valida filtros y encola un job en BullMQ/Redis (`director:jobs:reports`) con los parámetros normalizados. Se crea un registro `director_report_jobs` con `job_id`, `requester_id`, `status=pending`, `progress=0`, `params` (JSON) y `expires_at` (TTL configurable, p.ej. 24 h).
2. **Respuesta inmediata.** El API devuelve `202 Accepted` con `{ "taskId": job_id }`. El cliente usa este identificador para consultar progreso.
3. **Ejecución en worker.** Un worker dedicado procesa la cola, carga los datos desde las vistas materializadas o queries ad-hoc y actualiza `progress` (0–100%) mediante `reports:update-progress` en Redis (`HSET director:report:job:<id> progress=X`, TTL 24 h). Si el cálculo es grande, dividir en etapas (fetch, aggregate, export) y notificar cada una.
4. **Resultado.** Al terminar, el worker almacena el archivo o payload en S3 (pre-signed URL) o en Redis/Postgres (columna `result`) y marca `status=completed`, `completed_at=NOW()`. En caso de error, guardar `status=failed`, `error_message` y mantener el TTL para debugging.
5. **Consulta.** Nuevos endpoints `GET /director/reports/tasks/:id` (estado) y `GET /director/reports/tasks/:id/result` (resultado final) leen de Redis primero y, si expiró la caché, del registro en base de datos siempre que `expires_at` siga vigente.

### Consideraciones adicionales

- TTL configurable (`DIRECTOR_REPORT_JOB_TTL_SECONDS`, default 86 400) controla tanto la expiración de claves en Redis como la limpieza de filas caducadas (job de mantenimiento nocturno).
- Los workers emiten métricas (`director.jobs.reports.duration`, `status`) y logs estructurados para observabilidad.
- Limitar la concurrencia por organizador o tipo de reporte (`jobOptions.limiter`) para evitar presión en la base de datos.
- Permitir cancelación manual (`POST /director/reports/tasks/:id/cancel`) que marque `status=cancelled` y remueva el job de la cola cuando sea posible.

## Variables de entorno

| Variable | Descripción |
| --- | --- |
| `REDIS_URL` | Cache para KPIs y ledger. |
| `TICKET_PREMIUM_FACTOR` | Multiplicador para eventos tipo `premium`. |
| `DIRECTOR_CACHE_TTL_SECONDS` | TTL (segundos) para la caché de overview. |
| `DIRECTOR_REPORT_CACHE_TTL_SECONDS` | TTL de los reportes avanzados (`/director/reports/*`). |
| `KPI_REFRESH_INTERVAL_MINUTES` | Intervalo del job que refresca vistas y precalienta reportes (por defecto 30 min). |

## Flujo de pruebas

```bash
# Asignación de tickets (prepago)
curl -sS -X POST http://localhost:8080/director/assign \
  -H "Content-Type: application/json" \
  -d '{"organizerId":"org_demo","eventId":"ev_demo","type":"prepaid","tickets":100,"price":3.5}'

# Consulta de ledger
curl -sS http://localhost:8080/director/organizers/org_demo/ledger

# Pago registrado
curl -sS -X POST http://localhost:8080/director/payments \
  -H "Content-Type: application/json" \
  -d '{"organizerId":"org_demo","amount":1500,"currency":"mxn"}'
```

Las respuestas deben incluir `requestId`, la lista de movimientos y el saldo actualizado.
