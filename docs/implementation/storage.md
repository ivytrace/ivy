# Storage

## Decision: use the Collector's ClickHouse exporter, add our tables as materialized views

The answer to the spec's open question "Does the Collector's ClickHouse exporter schema fit, or do we write our own exporter?" is: it fits. We use the
contrib `clickhouse` exporter (pinned `otel/opentelemetry-collector-contrib:0.165.0`) writing to
its standard `otel_traces` table. Everything Ivy-specific is derived inside ClickHouse with materialized views.

Why:
- No custom ingest code to maintain. The Collector gives us OTLP gRPC+HTTP, auth, batching,
  retries and a persistent on-disk queue (`file_storage`) for free, and any OTLP producer works.
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
- Ingest-side tenant resolution (API key → tenant) is not done yet. `TenantId` defaults from the resource
  attribute `ivy.tenant_id`, or `'default'` when that attribute is missing.

## Tables (`deploy/clickhouse/schema.sql`)

| table | engine | ORDER BY | purpose |
|---|---|---|---|
| `otel_traces` | MergeTree, daily partitions | `(TenantId, toStartOfHour(Timestamp), TraceId)` | all spans; trace lookups |
| `invocations` (MV `invocations_mv`) | MergeTree, daily partitions | `(tenant_id, function, ts)` | one row per root span with `ivy.invocation = 'true'` |
| `invocations_hourly` (MV `invocations_hourly_mv`) | AggregatingMergeTree | `(tenant_id, function, region, hour)` | counts, errors, cold starts, duration sum, last invoked, `quantilesTDigest(0.5,0.95,0.99)` state |

- `otel_traces` is ordered for trace lookups, not per-service scans. Per-function queries go through
  `invocations`. A trace lookup is a range scan over about 3 hour buckets, plus a binary search on TraceId.
- Retention: `TTL … + toIntervalDay(IVY_RETENTION_DAYS)` (default 30) on all three tables,
  `ttl_only_drop_parts = 1` so whole daily partitions are dropped.
- Skip indexes: bloom filters on `TraceId`/`trace_id`/`request_id`/`error_fingerprint` and on span
  attribute keys/values; ngram bloom filters on `http_path` and `error_message`.
- `invocations` fields: `error_type` = `error.type` or the `exception` event's type, and `error_message` =
  status message or `exception.message`. The `error_fingerprint` is
  `cityHash64(function, error_type, message with UUIDs / long hex / numbers replaced)`.
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

The ClickHouse image runs `deploy/clickhouse/init.sh` on first start (empty volume only). The script fills in the
retention days in `schema.sql` and applies it. All statements are `IF NOT EXISTS`, so re-running is safe:
`docker compose exec clickhouse /docker-entrypoint-initdb.d/init.sh`. Changing retention on an
existing volume needs `ALTER TABLE … MODIFY TTL`. A real migration runner is still to do.
