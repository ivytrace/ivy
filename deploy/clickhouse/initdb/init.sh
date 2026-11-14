#!/bin/bash
# Applies schema.sql. Runs on first start (empty volume) and is safe to re-run:
#   docker compose -f deploy/docker-compose.yml exec clickhouse /docker-entrypoint-initdb.d/init.sh
# (`pnpm db:migrate` runs exactly that). See docs/implementation/storage.md, "Schema application".
set -euo pipefail
ch() { clickhouse client --user "${CLICKHOUSE_USER:-default}" --password "${CLICKHOUSE_PASSWORD:-}" "$@"; }

# Volumes from before workspaces and projects can't be brought up to date in place (pre-release):
# they need the one-off reset in deploy/clickhouse/reset.sql (`pnpm db:reset`), which drops all data.
if [ "$(ch -q "EXISTS TABLE ivy.otel_traces")" = 1 ] &&
  [ "$(ch -q "SELECT count() FROM system.columns WHERE database = 'ivy' AND table = 'otel_traces' AND name = 'ProjectId'")" = 0 ]; then
  echo "error: this ClickHouse volume predates workspaces and projects. Run the pre-release reset once:" >&2
  echo "  pnpm db:reset   (drops the ivy and ivy_control databases; see deploy/README.md)" >&2
  exit 1
fi

sed "s/{{RETENTION_DAYS}}/${IVY_RETENTION_DAYS:-30}/g" /ivy/schema.sql | ch --multiquery
echo "ivy schema applied (retention ${IVY_RETENTION_DAYS:-30} days)"
