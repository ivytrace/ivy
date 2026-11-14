# Storage

## Decision: use the Collector's ClickHouse exporter, add our tables as materialized views

The answer to the spec's open question "Does the Collector's ClickHouse exporter schema fit, or do we write our own exporter?" is: it fits. We use the
contrib `clickhouse` exporter (pinned `otel/opentelemetry-collector-contrib:0.165.0`) writing to
its standard `otel_traces` table. Everything Ivy-specific is derived inside ClickHouse with materialized views.

Why:
- Little custom ingest code. The Collector gives us OTLP decoding, batching, retries and a persistent on-disk
  queue (`file_storage`) for free, and any OTLP/HTTP producer works. In front of it, the ingest router
  (`tenancy.md`) only authenticates keys and forwards bodies unchanged.
- The exporter's span shape (attribute maps, nested events) holds everything in
  `span-conventions.md`. Attributes arrive as strings (arrays as JSON strings), which matches what the API
  contract already promises.
- Materialized views run on insert, so `invocations` and the rollups stay in sync with no extra service.

Trade-offs:
- `otel_traces` column names and types are defined by the exporter. We create the table ourselves
  (`create_schema: false`) with the same columns as 0.165.0's DDL, plus `TenantId`. When upgrading the
  Collector, diff its DDL (run it once with `create_schema: true` against a scratch database).
- The exporter writes `SpanKind` as `Server`/`Client`/… and `StatusCode` as `Ok`/`Error`/`Unset`. The API
  normalizes them to `SERVER`/`ERROR`/….
- `TenantId` and `ProjectId` default from the resource attributes `ivy.tenant_id` and `ivy.project_id`, which
  the collector sets from the ingest router's `x-ivy-tenant` and `x-ivy-project` headers after deleting whatever
  the client sent (`tenancy.md`, `workspaces-projects.md`). Workspace and project are therefore always the API
  key's, never the payload's.

## Tables (`deploy/clickhouse/schema.sql`)

Span data lives in the `ivy` database (one per cell/shard, see `tenancy.md`); the control plane (`tenants`
= workspaces, `projects`, `api_keys`, `tenant_members`, `invitations` and the auto-trace tables, `auto-trace.md`)
in `ivy_control`. Every table has the tenant first in `ORDER BY`; the span tables have the project second.

| table | engine | ORDER BY | purpose |
|---|---|---|---|
| `otel_traces` | MergeTree, daily partitions | `(TenantId, ProjectId, toStartOfHour(Timestamp), TraceId)` | all spans; trace lookups |
| `invocations` (MV `invocations_mv`) | MergeTree, daily partitions | `(tenant_id, project_id, function, ts)` | one row per root span with `ivy.invocation = 'true'` |
| `invocations_hourly` (MV `invocations_hourly_mv`) | AggregatingMergeTree | `(tenant_id, project_id, function, region, hour)` | counts, errors, cold starts, duration sum, last invoked, `quantilesTDigest(0.5,0.95,0.99)` state |

The MVs copy the project through (`ProjectId AS project_id`, `GROUP BY tenant_id, project_id, …`). Project-scoped
queries (the common case) read one `(tenant, project)` range of the primary key. Workspace-wide queries (function
overview and errors across all projects) read the tenant's range and group by `project_id`.

- `otel_traces` is ordered for trace lookups, not per-service scans. Per-function queries go through
  `invocations`. A trace lookup is a range scan over about 3 hour buckets, plus a binary search on TraceId.
- Retention: `TTL … + toIntervalDay(IVY_RETENTION_DAYS)` (default 30) on all three tables,
  `ttl_only_drop_parts = 1` so whole daily partitions are dropped.
- Row policies `ivy_tenant` on the three tables limit reads to the tenant in the `SQL_ivy_tenant` setting when
  a query sets it (the API always does), and `ivy_project` to the project in `SQL_ivy_project` (set by every
  project-scoped query; workspace-wide queries leave it unset). See `tenancy.md` for why they pass everything
  when the setting isn't set.
- Skip indexes: bloom filters on `TraceId`/`trace_id`/`request_id`/`error_fingerprint` and on span
  attribute keys/values; ngram bloom filters on `http_path` and `error_message`. They are unchanged by projects:
  the project is in the primary key, so it prunes by range and needs no index of its own, and the existing indexes
  work within the (tenant, project) range. A trace lookup is now `TenantId`/`ProjectId` prefix + hour buckets +
  TraceId bloom filter.
- `invocations` fields: `error_type` = `error.type` or the `exception` event's type, and `error_message` =
  status message or `exception.message`. The `error_fingerprint` is
  `cityHash64(function, error_type, message with UUIDs / long hex / numbers replaced)`.
  Empty strings / `0` mean "absent" and the API maps them to `null`.

## Query patterns (API)

- **Trace lookup:** take the first 8 hex chars of the trace ID as unix seconds. If that timestamp is
  plausible, query `Timestamp` in ±1h around it. If nothing is found, or the prefix isn't a timestamp, run
  a full query (TraceId bloom filter only). Verified: windowed lookup read ~3.5k rows of 64k.
- **`…/functions` and `…/stats/timeseries` (bucket ≥ 1h):** whole hours inside the range come from
  `invocations_hourly`, and the partial hours at either edge come from raw `invocations`. Quantile states from
  both sources are merged, so counts are exact for any `from`/`to`. Buckets of 1m/5m read `invocations` only.
- **`…/invocations`:** keyset pagination on `(ts, span_id)`. The cursor is base64url `[ts_ms, span_id]`.
- **`…/errors`:** `GROUP BY error_fingerprint, function` over `invocations`.

## Schema application

The ClickHouse image runs `deploy/clickhouse/init.sh` on first start (empty volume only). The script fills in the
retention days in `schema.sql` and applies it. Every statement is idempotent (`IF NOT EXISTS`, `OR REPLACE`, an
`ALTER … MODIFY COLUMN` to the current definition), so re-running is safe and brings an existing volume up to date:
`docker compose exec clickhouse /docker-entrypoint-initdb.d/init.sh`. `pnpm dev` runs it on every start.
Changing retention on an existing volume needs `ALTER TABLE … MODIFY TTL`. A real migration runner is still to do.

`pnpm db:migrate` runs it against the compose stack.

Pre-release schema changes are applied this way, without migrations. New control-plane columns use
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` (ClickHouse allows that in place). Two steps aren't plain DDL:

- The move of the auto-trace tables from `ivy` to `ivy_control`: `init.sh` renames `ivy.aws_*` to
  `ivy_control.aws_*` when the old table exists and the new one doesn't.
- **Projects** put `ProjectId`/`project_id` second in the sort key of all three span tables. ClickHouse can only
  append newly added columns to the end of an `ORDER BY` (`MODIFY ORDER BY`), not insert one in the middle, so
  `init.sh` rebuilds instead of altering: when `ivy.otel_traces` has no `ProjectId` column, it drops the two MVs and
  the derived `invocations`/`invocations_hourly`, renames `otel_traces` to `otel_traces_pre_projects`, applies the
  schema (new tables + MVs), then `INSERT … SELECT`s the old spans back with `ProjectId` = the workspace's default
  project. That ID is derived from the tenant ID (`prj_` + first 21 hex chars of
  `sha256('ivy-default-project:' || tenant)`), computed the same way in SQL and in the API, so no lookup is
  needed. The insert fires the MVs, which rebuild `invocations` and the rollups. Then the old table is dropped.
  If a run is interrupted after the rename, the next run stops with an error naming `otel_traces_pre_projects`
  rather than copying twice. Spans that arrive during the rebuild go to the new table, so on a large volume stop
  `collector` first. Verified on a volume made with the previous schema (300 spans over two tenants): counts per
  tenant were identical in all three tables afterwards, all under the right default project, and a second run was a
  no-op. Existing API keys (`project_id = ''`) belong to the default project; the API creates default projects and
  workspace slugs for existing tenants on startup (`ensureWorkspaceDefaults`).
