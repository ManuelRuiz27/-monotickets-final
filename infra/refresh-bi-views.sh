#!/usr/bin/env bash
set -euo pipefail

DB_HOST=${DB_HOST:-database}
DB_PORT=${DB_PORT:-5432}
DB_USER=${DB_USER:-postgres}
DB_NAME=${DB_NAME:-postgres}

psql_cmd=(psql "host=${DB_HOST}" "port=${DB_PORT}" "dbname=${DB_NAME}" "user=${DB_USER}" -v ON_ERROR_STOP=1)

views=(
  mv_confirmation_rate_daily
  mv_show_up_rate_daily
  mv_wa_free_ratio_daily
  mv_event_mix_90d
  mv_organizer_debt
)

echo "Refreshing BI materialized views..."
for view in "${views[@]}"; do
  echo " -> ${view}"
  if ! "${psql_cmd[@]}" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY ${view};"; then
    echo "Falling back to non-concurrent refresh for ${view}" >&2
    "${psql_cmd[@]}" -c "REFRESH MATERIALIZED VIEW ${view};"
  fi
  echo "${view} refreshed"
  echo
  sleep 1

done

echo "Done."
