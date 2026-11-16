#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

compose="docker compose -f deploy/docker-compose.yml"
export IVY_INGEST_API_KEY="${IVY_INGEST_API_KEY:-dev-ingest-key}"

$compose stop api >/dev/null 2>&1 || true
echo "Starting ClickHouse and ingest (the first run builds the ingest image)…"
$compose up -d --wait clickhouse
# Brings existing volumes up to date (the schema is idempotent).
$compose exec -T clickhouse /docker-entrypoint-initdb.d/init.sh
$compose up -d --wait --build ingest

echo
echo "  Dashboard  http://localhost:5173  (hot reload)"
echo "  API        http://localhost:3000  (restarts on change)"
echo "  OTLP       http://localhost:4318  (ingest in Docker; Authorization: Bearer ${IVY_INGEST_API_KEY})"
echo "  Sample data: pnpm --filter loadgen start -- --count 5000 --backfill 24"
echo

exec pnpm exec concurrently --kill-others --names api,ui --prefix-colors blue,green \
  "pnpm --filter @ivy/api dev" \
  "pnpm --filter @ivy/ui dev"
