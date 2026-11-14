CREATE DATABASE IF NOT EXISTS ivy;

CREATE TABLE IF NOT EXISTS ivy.otel_traces
(
    `TenantId` LowCardinality(String) DEFAULT if(ResourceAttributes['ivy.tenant_id'] = '', 'default', ResourceAttributes['ivy.tenant_id']) CODEC(ZSTD(1)),
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

CREATE TABLE IF NOT EXISTS ivy.invocations
(
    `tenant_id` LowCardinality(String) DEFAULT 'default',
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
