# Load Testing Playbook

This document defines the process to execute ad-hoc load tests against staging
before major releases.

## Tooling options

- **k6**: HTTP scenarios with ramping stages (`k6 run scripts/scan.js`).
- **autocannon**: CLI for quick burst tests (`npx autocannon -d 60 -c 50 https://staging.monotickets.io/scan/validate`).
- **hey**: Lightweight binary for linear load (`hey -n 5000 -c 100`).

> Use production-like payloads. For `/scan/validate`, vary the ticket codes to
> exercise all response paths.

## Preparing the environment

1. Switch staging to structured logs: set `LOG_FORMAT=json` and redeploy.
2. Scale services as required using `infra/scripts/scale.sh`:
   ```bash
   ./infra/scripts/scale.sh --service backend-api --replicas 3
   ./infra/scripts/scale.sh --service workers --replicas 4
   ```
3. Warm caches by running a short smoke test (50 requests) before the main run.
4. Confirm Prometheus is scraping `/metrics` and Grafana dashboard
   `latency-api` is visible.

## Success criteria

- `/scan/validate` p95 latency < **300 ms** and p99 < **500 ms** during the test.
- No more than **2%** HTTP 5xx responses.
- Worker dead-letter queue (DLQ) remains < **10** jobs (monitor with
  `queue_backlog{service="backend-api",queue="delivery_failed"}` from the
  backend metrics endpoint).

## Observability during the test

- Tail logs (JSON) to ensure `latency_ms` and `req_id` are present:
  ```bash
  docker compose logs -f backend-api | jq '.latency_ms, .req_id'
  ```
- Query Prometheus:
  ```promql
  histogram_quantile(0.95, sum(rate(http_request_duration_ms_bucket{service="backend-api"}[1m])) by (le, route))
  ```
- Export metrics snapshots at the end of the run for historical comparison.
- Keep a background poll (2 s interval) on the queue backlog to ensure DLQ
  headroom:
  ```bash
  watch -n2 'curl -s http://backend-api:8080/metrics | grep "queue_backlog{service=\"backend-api\",queue=\"delivery_failed\"}"'
  ```
  The value should remain below `10` throughout the load test.

## Post-test checklist

1. Capture Grafana screenshots (latency, error rate, throughput).
2. Record peak resource usage (CPU/memory) from the infrastructure provider.
3. Summarise findings in the release ticket, including:
   - Test date/time and tool used.
   - Target version (Docker image tag).
   - Whether success criteria were met.
4. Roll back scaling using `infra/scripts/scale.sh --service <name> --replicas 1`.
5. Reset `LOG_FORMAT` to `plain` if verbose logs are not required post-test.
