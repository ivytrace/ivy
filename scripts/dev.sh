#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

compose="docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml"
export IVY_INGEST_API_KEY="${IVY_INGEST_API_KEY:-dev-ingest-key}"
export IVY_COLLECTOR_TOKEN="${IVY_COLLECTOR_TOKEN:-dev-collector-token}"
export IVY_COLLECTOR_URL="${IVY_COLLECTOR_URL:-http://localhost:${IVY_COLLECTOR_DEV_PORT:-4319}}"

$compose stop api ingest >/dev/null 2>&1 || true
echo "Starting ClickHouse and the collector…"
$compose up -d --wait clickhouse collector
# Brings existing volumes up to date (the schema is idempotent).
$compose exec -T clickhouse /docker-entrypoint-initdb.d/init.sh

echo
echo "  Dashboard  http://localhost:5173  (hot reload)"
echo "  API        http://localhost:3000  (restarts on change)"
echo "  OTLP       http://localhost:4318  (ingest router; Authorization: Bearer ${IVY_INGEST_API_KEY})"
echo "  Sample data: pnpm --filter loadgen start -- --count 5000 --backfill 24"
echo

exec pnpm exec concurrently --kill-others --names api,ingest,ui --prefix-colors blue,magenta,green \
  "pnpm --filter @ivy/api dev" \
  "pnpm --filter @ivy/api dev:ingest" \
  "pnpm --filter @ivy/ui dev"
