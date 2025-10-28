# Docker Environment Variables

This guide documents the environment configuration required to run the Monotickets stack locally via `infra/docker-compose.yml`.

# [devops/env-update]
- Templates: `env/.env.local.example` (local) and `env/.env.staging.example` (staging).
- Secrets referenced as `GITHUB_SECRET:<NAME>` must exist in GitHub Secrets before CI/CD runs.
- Keep `LOG_FORMAT`, storage buckets, and API base URLs synchronized across the templates and `.env.example`.

## Core Application

| Variable | Description | Default |
| --- | --- | --- |
| `APP_ENV` | Execution environment label used by logs and health checks. | `development` |
| `PORT` | Port exposed by the backend API container. | `8080` |
| `LOG_FORMAT` | `json` enables structured logging; any other value keeps the plain formatter. | `plain` |
| `JWT_SECRET` | Symmetric secret for signing access tokens. Replace per environment. | `change_me` |
| `JWT_TTL_HOURS` | Duration of viewer/admin JWTs before renewal is required. | `8` |
| `STAFF_TOKEN_TTL_HOURS` | Staff session lifetime before re-authentication is required. | `24` |
| `STARTUP_RETRIES` | Number of attempts the backend makes when waiting for Postgres/Redis. | `10` |

## Database & Persistence

| Variable | Description | Default |
| --- | --- | --- |
| `DB_HOST` | Hostname of the PostgreSQL service. | `database` |
| `DB_PORT` | PostgreSQL port. | `5432` |
| `DB_USER` | Database user for application connections. | `postgres` |
| `DB_PASSWORD` | Database password. Replace outside local development. | `postgres` |
| `DB_NAME` | Primary database name. | `monotickets` |

The database container persists data in the `pg_data` volume. Future table partitioning for log retention (90–180 days) will be configured via migrations.

## Redis & Workers

| Variable | Description | Default |
| --- | --- | --- |
| `REDIS_URL` | Connection string for Redis (queue + cache operations). | `redis://redis:6379` |
| `WORKER_POLL_INTERVAL_MS` | Interval between worker heartbeat checks. | `5000` |
| `DELIVERY_QUEUE_NAME` | Queue key for outbound delivery jobs. | `deliveryQueue` |
| `WA_INBOUND_QUEUE_NAME` | Queue key for inbound WhatsApp webhooks. | `waInboundQueue` |
| `PAYMENTS_QUEUE_NAME` | Queue key for asynchronous payment processing. | `paymentsQueue` |
| `QUEUE_METRICS_INTERVAL_MS` | Frequency for emitting queue size metrics. | `30000` |
| `QUEUE_BACKOFF_DELAY_MS` | Base delay (ms) for exponential retry backoff. | `5000` |
| `PAYMENTS_WEBHOOK_BACKOFF_MS` | Retry delay for payment webhooks when remote providers fail. | `3000` |
| `WA_WEBHOOK_BACKOFF_DELAY_MS` | Retry delay for inbound WhatsApp webhook processing. | `2000` |

Uploads generated locally (PDF/media) are mounted through the `uploads_local` volume, simulating Cloudflare R2 during development.

## Object Storage (R2 Simulation)

| Variable | Description |
| --- | --- |
| `R2_ACCESS_KEY_ID` | Placeholder access key for the simulated R2 bucket. Store real values in GitHub Secrets/infra vaults. |
| `R2_SECRET_ACCESS_KEY` | Placeholder secret key. |
| `R2_BUCKET` | Bucket name used by backend and workers. |
| `R2_ENDPOINT` | Endpoint for the local R2 emulator (`https://r2.local.simulated`). |

To map the uploads directory when running locally, create `docker-compose.override.yml` with a bind mount pointing to a host path, or update `uploads_local` volume to point to a specific directory.

## Third-Party Integrations

| Variable | Description |
| --- | --- |
| `WA_360DIALOG_API_KEY` | WhatsApp (360dialog) API key. Use GitHub Secrets for CI/CD. |
| `WA_360DIALOG_API_URL` | Override default 360dialog endpoint if using a regional tenant. |
| `WA_SESSION_TTL_SECONDS` | TTL applied to Redis/DB session window (default 24h). |
| `RESEND_API_KEY` | Resend email API key. |
| `RESEND_API_URL` | Optional Resend API endpoint override. |
| `RESEND_FROM_EMAIL` | Default sender address for transactional emails. |
| `DEFAULT_ORGANIZER_ID` | UUID por defecto cuando la petición no envía `organizerId`. |
| `PAYMENTS_PROVIDER` | `stripe`, `conekta` or `mock` to choose primary processor. |
| `STRIPE_SECRET_KEY` | Stripe secret (test/live) used to create payment intents. |
| `STRIPE_API_URL` | Stripe API base for payment intent creation. |
| `CONEKTA_API_KEY` | Conekta private key used for charges. |
| `CONEKTA_API_URL` | Conekta Orders API base URL. |

## Frontend

| Variable | Description | Default |
| --- | --- | --- |
| `FRONTEND_PORT` | Port served by the frontend container. | `3000` |
| `NEXT_PUBLIC_API_BASE` | Base URL exposed to the web client for API calls. | `http://localhost:8080` |

Override browser-facing values using `.env.local` (for Next.js in future phases) or environment-specific compose overrides.

## Logs estructurados y métricas

- Si defines `LOG_FORMAT=json`, tanto el backend como los workers emitirán a `stdout` eventos JSON con los campos `ts`, `level`, `service`, `req_id`, `path`, `status` y `latency_ms` cuando aplique.
- El backend expone `GET /metrics` con las series `http_request_duration_ms_bucket`, `http_request_duration_ms_sum` y `http_request_duration_ms_count` (etiquetas `service`, `method`, `route`, `status`), además de los contadores `http_requests_total` y `http_requests_5xx_total` para monitorear errores. Mantén el endpoint habilitado únicamente en redes privadas.
- Para correlacionar peticiones, la cabecera `x-request-id` se propaga a las respuestas y a los logs; en `/scan/validate` se añade `event_id` al registro final cuando está presente en la carga útil.

## Trabajos en segundo plano

- `LANDING_TTL_DEFAULT_DAYS`, `LANDING_TTL_LOCK_TTL_SECONDS`, `LANDING_JOB_HOUR` y `LANDING_JOB_MINUTE` controlan el job nocturno que archiva/expira landings. Ajusta los valores por entorno y usa `--dry-run`/`--force` en el contenedor `workers` para QA.
- `DIRECTOR_CACHE_TTL_SECONDS` define el TTL del caché de panel en Redis.
- Ajusta los umbrales de reintento (`QUEUE_BACKOFF_DELAY_MS`, `PAYMENTS_WEBHOOK_BACKOFF_MS`, `WA_WEBHOOK_BACKOFF_DELAY_MS`) según los SLAs de cada proveedor.

## Variables sensibles por entorno (local/staging)

| Variable | Local (`.env`) | GitHub Secret (staging) | Servicios consumidores |
| --- | --- | --- | --- |
| `JWT_SECRET` | `JWT_SECRET` | `JWT_SECRET` | backend-api, workers |
| `JWT_TTL_HOURS` | `JWT_TTL_HOURS` | `JWT_TTL_HOURS` | backend-api |
| `STAFF_TOKEN_TTL_HOURS` | `STAFF_TOKEN_TTL_HOURS` | `STAFF_TOKEN_TTL_HOURS` | backend-api |
| `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `DB_*` | `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | backend-api, workers |
| `REDIS_URL` | `REDIS_URL` | `REDIS_URL_STAGING` o `UPSTASH_REDIS_URL` | backend-api, workers |
| `R2_ACCESS_KEY_ID` | `R2_ACCESS_KEY_ID` | `R2_ACCESS_KEY_ID` | backend-api, workers |
| `R2_SECRET_ACCESS_KEY` | `R2_SECRET_ACCESS_KEY` | `R2_SECRET_ACCESS_KEY` | backend-api, workers |
| `R2_BUCKET` | `R2_BUCKET` | `R2_BUCKET` | backend-api, workers |
| `R2_ENDPOINT` | `R2_ENDPOINT` | `R2_ENDPOINT` | backend-api, workers |
| `WA_360DIALOG_API_KEY` | `WA_360DIALOG_API_KEY` | `WA_360DIALOG_API_KEY` | backend-api |
| `RESEND_API_KEY` | `RESEND_API_KEY` | `RESEND_API_KEY` | backend-api |
| `STRIPE_SECRET_KEY` | `STRIPE_SECRET_KEY` | `STRIPE_SECRET_KEY` | backend-api, workers |
| `CONEKTA_API_KEY` | `CONEKTA_API_KEY` | `CONEKTA_API_KEY` | backend-api, workers |
| `PAYMENTS_PROVIDER` | `PAYMENTS_PROVIDER` | `PAYMENTS_PROVIDER` | backend-api, workers |
| `NEXT_PUBLIC_API_BASE` | `NEXT_PUBLIC_API_BASE` | `NEXT_PUBLIC_API_BASE` | frontend |
| `SUPABASE_URL` | _(no aplica local)_ | `SUPABASE_URL` | frontend (build) |
| `SUPABASE_KEY` | _(no aplica local)_ | `SUPABASE_KEY` | frontend (build) |
| `TESTSPRITE_API_KEY` | _(no aplica local)_ | `TESTSPRITE_API_KEY` | GitHub Actions (TestSprite) |
| `REGISTRY_URL` | _(no aplica local)_ | `REGISTRY_URL` | GitHub Actions (build & deploy) |
| `REGISTRY_USERNAME` | _(no aplica local)_ | `REGISTRY_USERNAME` | GitHub Actions |
| `REGISTRY_PASSWORD` | _(no aplica local)_ | `REGISTRY_PASSWORD` | GitHub Actions |
| `SSH_HOST` / `SSH_USER` / `SSH_KEY` | _(no aplica local)_ | `SSH_HOST`, `SSH_USER`, `SSH_KEY` | Deploy staging |
| `CLOUDFLARE_API_TOKEN` | _(no aplica local)_ | `CLOUDFLARE_API_TOKEN` | Infra scripts / R2 lifecycle |

> **Nota:** Mantén sincronizados los nombres entre `.env.example`, `docs/secrets-setup.md` y las configuraciones de GitHub Secrets para evitar fallos en CI/CD.

## Test Automation

| Variable | Description | Default |
| --- | --- | --- |
| `E2E_EVENT_ID` | Identificador de evento usado en las comprobaciones HTTP del runner E2E. | `demo-event` |
| `E2E_SAMPLE_CODE` | Código de ejemplo que se envía al endpoint `/scan/validate`. | `MONO-123-ABC` |
| `TEST_TARGET_API` | URL que consume el runner E2E para validar el backend. | `http://backend-api:8080` |
| `TEST_TARGET_WEB` | URL que consume el runner E2E para validar el frontend. | `http://frontend:3000` |

## Overriding per Environment

1. Copy `.env.example` to `.env` for local development.
2. For personal overrides, create `.env.local` or `.env.development.local` (ignored by git) and adjust values.
3. In containerized environments, use `docker-compose.override.yml` to inject per-service overrides, for example to bind `uploads_local` to a host folder:

   ```yaml
   services:
     backend-api:
       volumes:
         - ./local-uploads:/app/uploads
   ```

4. In CI, define secrets/environment variables within GitHub Actions (por ejemplo `JWT_SECRET`, claves de 360dialog, Resend o los valores del runner E2E).

Keeping secrets out of the repository ensures consistent local experience without exposing credentials.
