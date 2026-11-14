-- Applied by init.sh on first start, and safe to re-run (every statement is idempotent).
-- Two databases: `ivy` holds span data (one per cell/shard), `ivy_control` the control plane
-- (tenants, API keys, auto-trace config). See docs/implementation/tenancy.md.
CREATE DATABASE IF NOT EXISTS ivy;
CREATE DATABASE IF NOT EXISTS ivy_control;

CREATE TABLE IF NOT EXISTS ivy.otel_traces
(
    `TenantId` LowCardinality(String) DEFAULT ResourceAttributes['ivy.tenant_id'] CODEC(ZSTD(1)),
    `Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `TraceId` String CODEC(ZSTD(1)),
    `SpanId` String CODEC(ZSTD(1)),
    `ParentSpanId` String CODEC(ZSTD(1)),
    `TraceState` String CODEC(ZSTD(1)),
    `SpanName` LowCardinality(String) CODEC(ZSTD(1)),
    `SpanKind` LowCardinality(String) CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `SpanAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `Duration` UInt64 CODEC(ZSTD(1)),
    `StatusCode` LowCardinality(String) CODEC(ZSTD(1)),
    `StatusMessage` String CODEC(ZSTD(1)),
    `Events.Timestamp` Array(DateTime64(9)) CODEC(ZSTD(1)),
    `Events.Name` Array(LowCardinality(String)) CODEC(ZSTD(1)),
    `Events.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Links.TraceId` Array(String) CODEC(ZSTD(1)),
    `Links.SpanId` Array(String) CODEC(ZSTD(1)),
    `Links.TraceState` Array(String) CODEC(ZSTD(1)),
    `Links.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_value mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_duration Duration TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (TenantId, toStartOfHour(Timestamp), TraceId)
TTL toDateTime(Timestamp) + toIntervalDay({{RETENTION_DAYS}})
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- The tenant is set by the collector from the ingest router's header, which replaces any
-- client-supplied `ivy.tenant_id`. Older schemas fell back to the client's attribute or 'default'.
ALTER TABLE ivy.otel_traces MODIFY COLUMN `TenantId` LowCardinality(String) DEFAULT ResourceAttributes['ivy.tenant_id'] CODEC(ZSTD(1));

CREATE TABLE IF NOT EXISTS ivy.invocations
(
    `tenant_id` LowCardinality(String),
    `ts` DateTime64(3) CODEC(Delta(8), ZSTD(1)),
    `trace_id` String CODEC(ZSTD(1)),
    `span_id` String CODEC(ZSTD(1)),
    `function` LowCardinality(String),
    `region` LowCardinality(String),
    `status` LowCardinality(String),
    `duration_ms` Float64 CODEC(ZSTD(1)),
    `cold_start` Bool,
    `request_id` String CODEC(ZSTD(1)),
    `trigger` LowCardinality(String),
    `http_method` LowCardinality(String),
    `http_path` String CODEC(ZSTD(1)),
    `http_status` UInt16,
    `error_type` LowCardinality(String),
    `error_message` String CODEC(ZSTD(1)),
    `error_fingerprint` String,
    `memory_used_mb` Float32,
    INDEX idx_trace_id trace_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_request_id request_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_http_path http_path TYPE ngrambf_v1(3, 4096, 3, 0) GRANULARITY 1,
    INDEX idx_error_message error_message TYPE ngrambf_v1(3, 8192, 3, 0) GRANULARITY 1,
    INDEX idx_error_fingerprint error_fingerprint TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, function, ts)
TTL toDateTime(ts) + toIntervalDay({{RETENTION_DAYS}})
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS ivy.invocations_mv TO ivy.invocations AS
WITH
    arrayFirstIndex(n -> n = 'exception', `Events.Name`) AS ex_idx,
    if(ex_idx > 0, `Events.Attributes`[ex_idx], map()) AS ex,
    StatusCode = 'Error' AS is_error,
    if(ResourceAttributes['faas.name'] != '', ResourceAttributes['faas.name'], ServiceName) AS fn,
    if(is_error, if(SpanAttributes['error.type'] != '', SpanAttributes['error.type'], ex['exception.type']), '') AS err_type,
    if(is_error, if(StatusMessage != '', StatusMessage, ex['exception.message']), '') AS err_message,
    replaceRegexpAll(
        replaceRegexpAll(
            replaceRegexpAll(err_message, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<uuid>'),
            '\\b[0-9a-fA-F]{16,}\\b', '<hex>'),
        '\\d+(\\.\\d+)?', '<n>') AS err_normalized
SELECT
    TenantId AS tenant_id,
    toDateTime64(Timestamp, 3) AS ts,
    TraceId AS trace_id,
    SpanId AS span_id,
    fn AS function,
    ResourceAttributes['cloud.region'] AS region,
    if(is_error, 'error', 'ok') AS status,
    Duration / 1e6 AS duration_ms,
    SpanAttributes['faas.coldstart'] = 'true' AS cold_start,
    SpanAttributes['faas.invocation_id'] AS request_id,
    if(SpanAttributes['ivy.trigger.source'] != '', SpanAttributes['ivy.trigger.source'], 'unknown') AS trigger,
    SpanAttributes['http.request.method'] AS http_method,
    SpanAttributes['url.path'] AS http_path,
    toUInt16OrZero(SpanAttributes['http.response.status_code']) AS http_status,
    err_type AS error_type,
    err_message AS error_message,
    if(is_error, lower(hex(cityHash64(fn, err_type, err_normalized))), '') AS error_fingerprint,
    toFloat32OrZero(SpanAttributes['ivy.memory_used_mb']) AS memory_used_mb
FROM ivy.otel_traces
WHERE SpanAttributes['ivy.invocation'] = 'true';

CREATE TABLE IF NOT EXISTS ivy.invocations_hourly
(
    `tenant_id` LowCardinality(String),
    `hour` DateTime,
    `function` LowCardinality(String),
    `region` LowCardinality(String),
    `invocations` SimpleAggregateFunction(sum, UInt64),
    `errors` SimpleAggregateFunction(sum, UInt64),
    `cold_starts` SimpleAggregateFunction(sum, UInt64),
    `duration_sum` SimpleAggregateFunction(sum, Float64),
    `last_invoked` SimpleAggregateFunction(max, DateTime64(3)),
    `duration_q` AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), Float64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, function, region, hour)
TTL hour + toIntervalDay({{RETENTION_DAYS}});

CREATE MATERIALIZED VIEW IF NOT EXISTS ivy.invocations_hourly_mv TO ivy.invocations_hourly AS
SELECT
    tenant_id,
    toStartOfHour(ts) AS hour,
    function,
    region,
    count() AS invocations,
    countIf(status = 'error') AS errors,
    countIf(cold_start) AS cold_starts,
    sum(duration_ms) AS duration_sum,
    max(ts) AS last_invoked,
    quantilesTDigestState(0.5, 0.95, 0.99)(duration_ms) AS duration_q
FROM ivy.invocations
GROUP BY tenant_id, hour, function, region;

-- Defence in depth: when a query sets SQL_ivy_tenant (the API does for every query, see
-- packages/api/src/lib/clickhouse/scoped.ts), only that tenant's rows are visible, even if the
-- SQL forgot its tenant filter. Without the setting (collector inserts, materialized views,
-- admin sessions) the policy lets everything through: a fail-closed policy would also filter
-- the rows materialized views read on insert.
CREATE ROW POLICY OR REPLACE ivy_tenant ON ivy.otel_traces AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_tenant', '') = '' OR TenantId = getSettingOrDefault('SQL_ivy_tenant', '') TO ALL;
CREATE ROW POLICY OR REPLACE ivy_tenant ON ivy.invocations AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_tenant', '') = '' OR tenant_id = getSettingOrDefault('SQL_ivy_tenant', '') TO ALL;
CREATE ROW POLICY OR REPLACE ivy_tenant ON ivy.invocations_hourly AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_tenant', '') = '' OR tenant_id = getSettingOrDefault('SQL_ivy_tenant', '') TO ALL;

-- Control plane. Small, mutable tables: every update inserts a full row, ReplacingMergeTree
-- keeps the newest version, reads use FINAL.

CREATE TABLE IF NOT EXISTS ivy_control.tenants
(
    `id` String,
    `name` String,
    `shard_id` LowCardinality(String) DEFAULT 'shard-1',
    `created_at` DateTime64(3, 'UTC'),
    `updated_at` DateTime64(3, 'UTC'),
    `deleted` UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id;

-- Keys are stored as sha256(key) plus a display prefix. `encrypted_key` is only set for keys Ivy
-- hands out itself (the per-tenant auto-trace key), encrypted with IVY_SECRET_KEY.
CREATE TABLE IF NOT EXISTS ivy_control.api_keys
(
    `tenant_id` String,
    `id` String,
    `name` String,
    `kind` LowCardinality(String),
    `key_hash` String,
    `prefix` String,
    `encrypted_key` String DEFAULT '',
    `created_at` DateTime64(3, 'UTC'),
    `revoked_at` Nullable(DateTime64(3, 'UTC')),
    `updated_at` DateTime64(3, 'UTC'),
    INDEX idx_key_hash key_hash TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, id);

-- Auto-trace configuration (docs/implementation/auto-trace.md).

CREATE TABLE IF NOT EXISTS ivy_control.aws_accounts
(
    `tenant_id` LowCardinality(String),
    `id` String,
    `name` String,
    `account_id` String,
    `role_arn` String,
    `external_id` String,
    `event_secret` String,
    `stack_name` String,
    `stack_region` LowCardinality(String),
    `regions` Array(LowCardinality(String)),
    `all_regions` Bool,
    `status` LowCardinality(String),
    `error` String,
    `created_at` DateTime64(3, 'UTC'),
    `verified_at` DateTime64(3, 'UTC'),
    `last_sync_at` DateTime64(3, 'UTC'),
    `updated_at` DateTime64(3, 'UTC'),
    `deleted` UInt8
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, id);

CREATE TABLE IF NOT EXISTS ivy_control.aws_functions
(
    `tenant_id` LowCardinality(String),
    `account_id` String,
    `region` LowCardinality(String),
    `function_name` String,
    `function_arn` String,
    `runtime` LowCardinality(String),
    `state` LowCardinality(String),
    `reason` String,
    `updated_at` DateTime64(3, 'UTC'),
    `deleted` UInt8
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, account_id, region, function_name);

CREATE TABLE IF NOT EXISTS ivy_control.aws_function_settings
(
    `tenant_id` LowCardinality(String),
    `account_id` String,
    `region` LowCardinality(String),
    `function_name` String,
    `tracing_enabled` Bool,
    `updated_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, account_id, region, function_name);
