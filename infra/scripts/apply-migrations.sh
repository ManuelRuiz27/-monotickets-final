#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$ROOT_DIR/migrations"

DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-monotickets}
DB_USER=${DB_USER:-postgres}
DB_PASSWORD=${DB_PASSWORD:-postgres}

if ! command -v psql >/dev/null 2>&1; then
  echo "Error: psql no está instalado o no está en el PATH. Instala el cliente de PostgreSQL." >&2
  exit 1
fi

run_sql() {
  local file=$1
  echo "Applying ${file##*/}" >&2
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
  else
    PGPASSWORD="$DB_PASSWORD" psql \
      -h "$DB_HOST" \
      -p "$DB_PORT" \
      -U "$DB_USER" \
      -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 \
      -f "$file"
  fi
}

mapfile -t migrations < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort)

for migration in "${migrations[@]}"; do
  base="$(basename "$migration")"
  if [[ "$base" == "040_seed.sql" ]]; then
    echo "Skipping seed file $base" >&2
    continue
  fi
  run_sql "$migration"
  echo >&2

done
