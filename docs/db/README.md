# Base de datos · Migraciones y semilla

Este proyecto utiliza PostgreSQL (compatible con Supabase) orquestado desde `infra/docker-compose.yml`. Sigue estos pasos para crear la base de datos local con el esquema inicial, datos de ejemplo y vistas materializadas para BI.

## 1. Levantar la base de datos

El stack principal ya se documenta en el `README.md` raíz. Para un entorno mínimo de base de datos basta con iniciar el servicio `database` definido en Compose:

```bash
docker compose -f infra/docker-compose.yml up -d database
```

Los parámetros (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`) provienen de tu archivo `.env`. Si es la primera vez que lo ejecutas, PostgreSQL inicializará el volumen `pg_data` automáticamente.

## 2. Ejecutar migraciones y seed

El script `infra/scripts/seed.sh` aplica en orden todas las migraciones de `infra/migrations/` y finalmente carga la semilla `040_seed.sql`.
Necesitas tener el cliente `psql` disponible (se instala junto con PostgreSQL). Si prefieres no instalarlo en tu host, ejecuta el script dentro del contenedor con `docker compose exec database bash`.

```bash
# Desde la raíz del repo
./infra/scripts/seed.sh
```

Por defecto el script usa las variables de entorno (`DB_HOST=localhost`, `DB_PORT=5432`, etc.). Si ejecutas el comando desde fuera del contenedor puedes exportar los valores o utilizar `DATABASE_URL`:

```bash
DB_HOST=localhost DB_PORT=5432 DB_USER=postgres DB_PASSWORD=postgres ./infra/scripts/seed.sh
# o
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/monotickets" ./infra/scripts/seed.sh
```

Al finalizar, deberías tener:

- 10 organizadores con precios diferenciados, estados (`active/suspended/archived`) y metadatos para billing.
- 2 eventos activos (standard y premium) con 16 invitados cada uno.
- Bitácoras de envíos y escaneos (>80 registros) con datos distribuidos en las dos particiones mensuales de `scan_logs`.
- Tablas financieras (`ticket_ledger`, `payments`) con >30 movimientos para cálculos de deuda y conciliación.
- Vistas materializadas refrescadas (`mv_*`) listas para su consumo en Metabase.
- Índices extra en `delivery_logs` (`event_id, created_at` y `status, created_at`) creados por la migración `20250115001_delivery_director_finalize.sql` para optimizar filtros de estado/fecha.

## 3. Refrescos programados

Si tu Postgres soporta `pg_cron`, la migración `110_pg_cron_refresh.sql` registra tareas para refrescar las vistas cada 5, 10 o 60 minutos. En entornos donde `pg_cron` no esté disponible, consulta la nota en `docs/bi/kpis.md` para levantar un worker externo que ejecute `REFRESH MATERIALIZED VIEW CONCURRENTLY`.

El worker de backend (`backend/src/jobs/kpi-refresh.js`) ejecuta `runKpiRefreshJob`, el cual:

1. Obtiene un lock en Redis para evitar ejecuciones simultáneas (`KPI_REFRESH_LOCK_KEY`).
2. Ejecuta `REFRESH MATERIALIZED VIEW CONCURRENTLY` sobre `mv_kpi_tickets_entregados`, `mv_kpi_deuda_abierta`, `mv_kpi_top_organizadores` y las vistas M1–M5.
3. Llama a los endpoints internos de reportes para precalentar la caché (`DIRECTOR_REPORT_CACHE_TTL_SECONDS`).

El intervalo del job se controla con `KPI_REFRESH_INTERVAL_MINUTES` (por defecto 30 minutos) y puede forzarse con la bandera `--force` al iniciar el worker.

## 4. Mantenimiento de particiones en `scan_logs` y `delivery_logs`
El worker (`backend/src/worker.js`) agenda `runLogPartitionMaintenanceJob` como un cron diario en horario UTC.

| Variable | Default | Descripción |
| --- | --- | --- |
| `SCAN_LOG_PARTITION_HOUR` | `2` | Hora (UTC) en la que corre el job diario. |
| `SCAN_LOG_PARTITION_MINUTE` | `30` | Minuto (UTC) programado para la ejecución. |
| `SCAN_LOG_PARTITION_LEAD_DAYS` | `5` | Días de anticipación para crear la partición del mes siguiente. |
| `SCAN_LOG_RETENTION_DAYS` | `180` | Ventana máxima de retención; particiones completas más antiguas se eliminan. |

El flujo automático realiza lo siguiente:

1. Garantiza particiones para el mes anterior, el corriente y el siguiente. Si falta alguna partición se emite `log_partition_missing` o `log_partition_missing_after_attempt`.
2. Crea anticipadamente la partición del mes siguiente cuando `now()` cae dentro de la ventana definida por `SCAN_LOG_PARTITION_LEAD_DAYS`.
3. Borra particiones completas con rango de fechas anterior a `current_date - SCAN_LOG_RETENTION_DAYS`, asegurando una ventana controlada entre 90 y 180 días.

### Ejecución manual y validaciones

Para entornos donde se necesite ejecutar la limpieza manualmente (staging/producción) existe el script:

```bash
cd backend
SCAN_LOG_RETENTION_DAYS=120 npm run cleanup:log-partitions
```

Incluye la bandera `--dry-run` (`npm run cleanup:log-partitions -- --dry-run`) para revisar qué acciones se tomarían sin aplicar las.

Los logs del worker incluyen `log_partition_job_scheduled` con la próxima ejecución y `log_partition_job_completed` al finalizar; revisa CloudWatch/Loki (según entorno) para confirmar la creación o eliminación de particiones.

## 5. Limpieza y resiembra

Para regenerar los datos simplemente elimina el volumen `pg_data` y repite los pasos:

```bash
docker compose -f infra/docker-compose.yml down -v
# luego vuelve a levantar y corre seed.sh
```

> **Tip:** los comandos de docker-compose se pueden encadenar con otros servicios (`redis`, `backend-api`, etc.) una vez que la base está lista.
