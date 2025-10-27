# DevOps Change Log

## [Unreleased]

## [v1.0.0-MVP] - 2025-10-15

- Documented the WhatsApp sessions table and `delivery_logs.is_free` across BI
  and Metabase docs, refreshing dashboard assets for the final dataset
  (`docs/bi/kpis.md`, `docs/bi/README.md`, `docs/bi/assets/*`).
- Added BullMQ instrumentation guidance with queue metrics, Alertmanager rules
  and example `/metrics` capture (`docs/observability.md`).
- Clarified the daily cron for log partitions, lead/retention variables and
  manual scripts (`docs/db/README.md`).
- Refreshed demo data for migrations and PWA fallbacks (new events, guests and
  WhatsApp sessions) (`infra/migrations/040_seed.sql`,
  `frontend/pwa/lib/api/guest.ts`).
- Synced environment templates with queue/WhatsApp session settings for local
  and staging deployments (`env/.env.local.example`,
  `env/.env.staging.example`).
- Release tag prepared: **v1.0.0-MVP** (ready for deploy).

### Deploy checklist

1. Ejecutar migraciones: `./infra/scripts/apply-migrations.sh` (usa las
   credenciales del entorno destino).
2. Refrescar seed/demo en entornos de QA o staging: `./infra/scripts/seed.sh`.
3. Reiniciar worker/API para cargar variables nuevas (`QUEUE_METRICS_INTERVAL_MS`,
   `SCAN_LOG_*`, `WA_SESSION_TTL_SECONDS`).
4. QA final (funcionalidad, rendimiento, UX):
   - `npm run test:e2e:all`
   - `npm run smoke:services` && `npm run smoke:readiness`

## [Earlier updates]

- (2025-10-13) Localized the compose source-of-truth banner and refreshed env
  templates for local/staging placeholders (`infra/docker-compose.yml`,
  `env/.env.local.example`, `env/.env.staging.example`).
- (2025-10-13) Extended observability with queue backlog/error metrics, JSON log
  toggles, and refreshed alert examples (`backend/src/logging.js`,
  `backend/src/server.js`, `docs/observability.md`,
  `infra/monitoring/alerts.examples/latency-error-dlq.yml`).
- (2025-10-12) Updated `infra/docker-compose.yml` to serve as the single source of
  truth for dev/staging, adding PWA/Dashboard services with healthchecks and
  documented orchestration details in `docs/compose-source-of-truth.md`.
- (2025-10-12) Added environment templates, artifact storage volumes, and
  documented secrets/volume handling (`env/.env.*.example`, `.env.example`,
  `docs/docker-env.md`, `docs/secrets-setup.md`, `docs/artifacts-storage.md`,
  `infra/docker-compose.yml`).
- (2025-10-12) Expanded observability guidance and alert examples, including JSON
  logging defaults and Prometheus rules (`env/.env.local.example`,
  `docs/observability.md`, `infra/monitoring/alerts.examples/latency-error-dlq.yml`).
- (2025-10-12) Updated CI/CD workflows to run smoke/E2E checks, build PWA/Dashboard
  images, and document staging deploy steps (`.github/workflows/*.yml`,
  `infra/scripts/deploy_staging.sh`, `docs/cicd.md`, `docs/deploy-staging.md`).
- Added structured logging with optional JSON format and Prometheus histogram
  metrics (`backend/src/server.js`, `backend/src/logging.js`).
- Documented secrets inventory and setup instructions (`docs/secrets-setup.md`,
  `.env.example`, `docs/docker-env.md`).
- Established backup & lifecycle strategy for PostgreSQL, Redis, and R2
  (`docs/backups-and-lifecycle.md`, `infra/scripts/backup_db.sh`,
  `infra/scripts/restore_db.sh`, `infra/scripts/r2_lifecycle_policies.md`).
- Introduced monitoring stubs and observability guidance (`docs/observability.md`,
  `infra/monitoring/*`).
- Created load testing and scaling utilities (`infra/scripts/scale.sh`,
  `docs/load-tests.md`).
- Implemented CI/CD pipeline updates for image builds and staging deploys
  (`.github/workflows/build-and-push.yml`, `.github/workflows/deploy-staging.yml`,
  `docs/cicd.md`).
