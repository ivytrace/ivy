#!/bin/bash
# Applies schema.sql. Runs on first start (empty volume) and is safe to re-run:
#   docker compose -f deploy/docker-compose.yml exec clickhouse /docker-entrypoint-initdb.d/init.sh
set -euo pipefail
ch() { clickhouse client --user "${CLICKHOUSE_USER:-default}" --password "${CLICKHOUSE_PASSWORD:-}" "$@"; }

# One-time move of the auto-trace tables from `ivy` to `ivy_control` (pre-release schema change).
ch -q "CREATE DATABASE IF NOT EXISTS ivy_control"
for table in aws_accounts aws_functions aws_function_settings; do
  if [ "$(ch -q "EXISTS TABLE ivy.$table")" = 1 ] && [ "$(ch -q "EXISTS TABLE ivy_control.$table")" = 0 ]; then
    ch -q "RENAME TABLE ivy.$table TO ivy_control.$table"
    echo "moved ivy.$table to ivy_control.$table"
  fi
done

sed "s/{{RETENTION_DAYS}}/${IVY_RETENTION_DAYS:-30}/g" /ivy/schema.sql | ch --multiquery
echo "ivy schema applied (retention ${IVY_RETENTION_DAYS:-30} days)"
