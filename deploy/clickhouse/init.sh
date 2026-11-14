#!/bin/bash
set -euo pipefail
sed "s/{{RETENTION_DAYS}}/${IVY_RETENTION_DAYS:-30}/g" /ivy/schema.sql \
  | clickhouse client --user "${CLICKHOUSE_USER:-default}" --password "${CLICKHOUSE_PASSWORD:-}" --multiquery
echo "ivy schema applied (retention ${IVY_RETENTION_DAYS:-30} days)"
