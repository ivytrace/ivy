#!/bin/bash
# Applies schema.sql. Runs on first start (empty volume) and is safe to re-run:
#   docker compose -f deploy/docker-compose.yml exec clickhouse /docker-entrypoint-initdb.d/init.sh
# (`pnpm db:migrate` runs exactly that). See docs/implementation/storage.md, "Schema application".
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

# One-time rebuild for projects (pre-release schema change). The span tables gained a project
# column in the middle of their ORDER BY, which ClickHouse can't ALTER, so: keep the spans aside,
# drop the derived tables, create everything new below, then copy the spans back in. Re-inserting
# into otel_traces runs the materialized views, which rebuild `invocations` and the rollups.
# Existing spans go to their workspace's default project (its ID is derived from the tenant ID).
OLD=ivy.otel_traces_pre_projects
if [ "$(ch -q "EXISTS TABLE $OLD")" = 1 ]; then
  echo "error: $OLD exists, so an earlier project migration was interrupted." >&2
  echo "Check ivy.otel_traces, then either drop $OLD or copy the missing rows yourself." >&2
  exit 1
fi
migrate_spans=0
if [ "$(ch -q "EXISTS TABLE ivy.otel_traces")" = 1 ] &&
  [ "$(ch -q "SELECT count() FROM system.columns WHERE database = 'ivy' AND table = 'otel_traces' AND name = 'ProjectId'")" = 0 ]; then
  ch -q "DROP VIEW IF EXISTS ivy.invocations_hourly_mv"
  ch -q "DROP VIEW IF EXISTS ivy.invocations_mv"
  ch -q "DROP TABLE IF EXISTS ivy.invocations_hourly"
  ch -q "DROP TABLE IF EXISTS ivy.invocations"
  ch -q "RENAME TABLE ivy.otel_traces TO $OLD"
  migrate_spans=1
fi

sed "s/{{RETENTION_DAYS}}/${IVY_RETENTION_DAYS:-30}/g" /ivy/schema.sql | ch --multiquery
echo "ivy schema applied (retention ${IVY_RETENTION_DAYS:-30} days)"

if [ "$migrate_spans" = 1 ]; then
  columns='TenantId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName,
    ResourceAttributes, ScopeName, ScopeVersion, SpanAttributes, Duration, StatusCode, StatusMessage,
    `Events.Timestamp`, `Events.Name`, `Events.Attributes`, `Links.TraceId`, `Links.SpanId`, `Links.TraceState`, `Links.Attributes`'
  rows=$(ch -q "SELECT count() FROM $OLD")
  ch -q "INSERT INTO ivy.otel_traces (ProjectId, $columns)
    SELECT concat('prj_', substring(lower(hex(SHA256(concat('ivy-default-project:', TenantId)))), 1, 21)), $columns FROM $OLD"
  ch -q "DROP TABLE $OLD"
  echo "migrated $rows spans to (tenant, project) ordering; they belong to each workspace's default project"
fi
