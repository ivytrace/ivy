#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

compose="docker compose -f deploy/docker-compose.yml"

$compose stop api >/dev/null 2>&1 || true
echo "Starting ClickHouse and the collector…"
$compose up -d --wait clickhouse collector

echo
echo "  Dashboard  http://localhost:5173  (hot reload)"
echo "  API        http://localhost:3000  (restarts on change)"
echo "  OTLP       http://localhost:4318  (Authorization: Bearer ${IVY_INGEST_API_KEY:-dev-ingest-key})"
echo "  Sample data: pnpm --filter loadgen start -- --count 5000 --backfill 24"
echo

exec pnpm exec concurrently --kill-others --names api,ui --prefix-colors blue,green \
  "pnpm --filter @ivy/api dev" \
  "pnpm --filter @ivy/ui dev"
