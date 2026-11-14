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
- `TenantId` defaults from the resource attribute `ivy.tenant_id`, which the collector sets from the ingest
  router's `x-ivy-tenant` header after deleting whatever the client sent (`tenancy.md`). The tenant is
  therefore always the one of the API key, never the payload's.

## Tables (`deploy/clickhouse/schema.sql`)

Span data lives in the `ivy` database (one per cell/shard, see `tenancy.md`); the control plane (`tenants`,
`api_keys` and the auto-trace tables, `auto-trace.md`) in `ivy_control`. Every table has the tenant first in
`ORDER BY`.

| table | engine | ORDER BY | purpose |
|---|---|---|---|
| `otel_traces` | MergeTree, daily partitions | `(TenantId, toStartOfHour(Timestamp), TraceId)` | all spans; trace lookups |
| `invocations` (MV `invocations_mv`) | MergeTree, daily partitions | `(tenant_id, function, ts)` | one row per root span with `ivy.invocation = 'true'` |
| `invocations_hourly` (MV `invocations_hourly_mv`) | AggregatingMergeTree | `(tenant_id, function, region, hour)` | counts, errors, cold starts, duration sum, last invoked, `quantilesTDigest(0.5,0.95,0.99)` state |

- `otel_traces` is ordered for trace lookups, not per-service scans. Per-function queries go through
  `invocations`. A trace lookup is a range scan over about 3 hour buckets, plus a binary search on TraceId.
- Retention: `TTL … + toIntervalDay(IVY_RETENTION_DAYS)` (default 30) on all three tables,
  `ttl_only_drop_parts = 1` so whole daily partitions are dropped.
- Row policies `ivy_tenant` on the three tables limit reads to the tenant in the `SQL_ivy_tenant` setting when
  a query sets it (the API always does). See `tenancy.md` for why they pass everything when it isn't set.
- Skip indexes: bloom filters on `TraceId`/`trace_id`/`request_id`/`error_fingerprint` and on span
  attribute keys/values; ngram bloom filters on `http_path` and `error_message`.
- `invocations` fields: `error_type` = `error.type` or the `exception` event's type, and `error_message` =
  status message or `exception.message`. The `error_fingerprint` is
  `cityHash64(function, error_type, message with UUIDs / long hex / numbers replaced)`. For failures the extension
  reports (`platform-failures.md`) the status message is the first meaningful log line, so an init failure groups as
  e.g. `Runtime.ImportModuleError` + `Error: Cannot find module 'left-pad'` (module names survive the normalization;
  digits in them become `<n>`).
- Platform columns: `failure_phase` (`ivy.failure.phase`: `init`/`invoke`, empty for handler errors), `synthetic`
  (`ivy.synthetic`: the extension created the span), `init_duration_ms` (`ivy.init_duration_ms`) and
  `memory_limit_mb` (resource `faas.max_memory`). They were added with `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, and
  `invocations_mv` is dropped and recreated on every schema run so query changes apply (spans inserted in those few
  milliseconds are not copied).
- Update spans (`ivy.update = true`, late Lambda report data) land in `otel_traces` only: they have no
  `ivy.invocation`, so they add no `invocations` row and are not counted as traces. The trace route folds them into
  the invocation span. Billed duration and max memory are therefore only in the trace view, not in `invocations`.
  Empty strings / `0` mean "absent" and the API maps them to `null`.

## Query patterns (API)

- **Trace lookup:** take the first 8 hex chars of the trace ID as unix seconds. If that timestamp is
  plausible, query `Timestamp` in ±1h around it. If nothing is found, or the prefix isn't a timestamp, run
  a full query (TraceId bloom filter only). Verified: windowed lookup read ~3.5k rows of 64k.
- **`/api/functions` and `/api/stats/timeseries` (bucket ≥ 1h):** whole hours inside the range come from
  `invocations_hourly`, and the partial hours at either edge come from raw `invocations`. Quantile states from
  both sources are merged, so counts are exact for any `from`/`to`. Buckets of 1m/5m read `invocations` only.
- **`/api/invocations`:** keyset pagination on `(ts, span_id)`. The cursor is base64url `[ts_ms, span_id]`.
- **`/api/errors`:** `GROUP BY error_fingerprint, function` over `invocations`.

## Schema application

The ClickHouse image runs `deploy/clickhouse/initdb/init.sh` on first start (empty volume only). The script fills in the
retention days in `schema.sql` and applies it. Every statement is idempotent (`IF NOT EXISTS`, `OR REPLACE`, an
`ALTER … MODIFY COLUMN` to the current definition), so re-running is safe and brings an existing volume up to date:
`docker compose exec clickhouse /docker-entrypoint-initdb.d/init.sh`. `pnpm dev` runs it on every start.
Changing retention on an existing volume needs `ALTER TABLE … MODIFY TTL`. A real migration runner is still to do.

Pre-release schema changes are applied this way, without migrations. The move of the auto-trace tables from `ivy`
to `ivy_control` is the one step that isn't a plain `CREATE … IF NOT EXISTS`: `init.sh` renames
`ivy.aws_*` to `ivy_control.aws_*` when the old table exists and the new one doesn't.
