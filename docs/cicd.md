# CI/CD Pipeline Overview

Monotickets uses GitHub Actions for CI, image builds, and staging deployments.
This document summarises the workflow topology and required secrets.

## Workflows

| Workflow | File | Trigger | Purpose |
| --- | --- | --- | --- |
| CI | `.github/workflows/ci.yml` | `pull_request` → `develop`, `main` | Runs lint, unit, smoke (`infra/docker-compose.yml`) and host-based E2E (`npm run test:e2e:all`) before executing TestSprite. |
| Build & Push | `.github/workflows/build-and-push.yml` | `push` to `develop`/`main`; `workflow_run` (CI success) | Builds Docker images (`backend-api`, `workers`, `frontend`, `pwa`, `dashboard`) and pushes them to the registry. |
| Deploy Staging | `.github/workflows/deploy-staging.yml` | `workflow_run` (Build & Push success); `workflow_dispatch` | Deploys the latest image tag to the staging host after validating smoke, E2E, and TestSprite status. |

## Image tagging

- Every build pushes `${REGISTRY_URL}/<service>:${GITHUB_SHA}`.
- Commits on `main` also publish the `latest` tag for rapid rollbacks.
- The deploy workflow references `github.event.workflow_run.head_sha` to select
  the image tag.
- Service map:
  - `backend-api`, `workers` → `./backend/Dockerfile`
  - `frontend`, `pwa`, `dashboard` → `./frontend/Dockerfile` (runtime decided via env/entry).

## Secrets & variables

| Name | Used in | Description |
| --- | --- | --- |
| `TESTSPRITE_API_KEY` | CI | API key for TestSprite smoke tests. |
| `REGISTRY_URL`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` | Build & Push, Deploy | Registry endpoint and credentials. |
| `SSH_HOST`, `SSH_USER`, `SSH_KEY` | Deploy Staging | SSH details for the staging host. |
| `STAGING_DB_HOST`, `STAGING_DB_PORT`, `STAGING_DB_NAME`, `STAGING_DB_USER`, `STAGING_DB_PASSWORD` | Build & Push, Deploy | PostgreSQL connection for applying migrations, refreshing KPI views and verifying `pg_cron`. |
| `METABASE_SITE_URL`, `METABASE_DATABASE_ID`, `METABASE_ORGANIZER_GROUP_ID`, `METABASE_DIRECTOR_GROUP_ID`, `METABASE_SESSION_TOKEN`, `METABASE_API_KEY` | Build & Push, Deploy | Credentials and metadata for automated Metabase dashboard sync. |
| `STAGING_BACKEND_HEALTH_URL`, `STAGING_FRONTEND_HEALTH_URL` | Deploy Staging | Health endpoints used after rollout validation. |
| `SCAN_LOG_RETENTION_DAYS` | Deploy (environment variables) | Controls retention window for log partition maintenance jobs. |
| `SUPABASE_URL`, `SUPABASE_KEY`, `REDIS_URL_STAGING`, `R2_*`, `CLOUDFLARE_API_TOKEN` | Deploy (environment variables) | Passed to the staging host for runtime configuration. |

Refer to `docs/secrets-setup.md` for CLI commands to seed these values.

### Smoke & E2E execution

- The smoke job boots `database`, `redis`, `backend-api`, `pwa`, and `dashboard`
  via `infra/docker-compose.yml` with `COMPOSE_PROFILES=dev`.
- Readiness checks rely on `npm run smoke:readiness` and `npm run smoke:services`
  targeting `http://localhost:8080`, `http://localhost:3000`, and
  `http://localhost:3100`.
- The E2E job reuses the same stack and executes `npm run test:e2e:all`, then
  runs `npm run test:post` to gather coverage and E2E artifacts.

## Manual deploys

Use the **Deploy Staging** workflow → **Run workflow** in GitHub Actions to force
an image rollout (e.g. hotfix). Provide the `image_tag` input to override the
SHA (defaults to latest successful Build & Push run).

## Promotion checklist

1. Ensure the CI workflow is green (lint, unit, smoke, E2E, TestSprite).
2. Confirm Build & Push completed for the target commit.
3. Trigger or wait for Deploy Staging. Monitor the logs in GitHub Actions.
4. Validate staging health endpoints:
   ```bash
   curl -sSf https://staging.monotickets.io/health
   ```
5. Update release notes with the deployed image tags and TestSprite report link.
