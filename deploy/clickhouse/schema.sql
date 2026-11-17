-- Applied by init.sh on first start, and safe to re-run (every statement is idempotent).
-- Two databases: `ivy` holds span data (one per cell/shard), `ivy_control` the control plane
-- (workspaces/tenants, projects, API keys, auto-trace config). See docs/implementation/tenancy.md
-- and docs/implementation/workspaces-projects.md. Span data is keyed (tenant, project, …).
CREATE DATABASE IF NOT EXISTS ivy;
CREATE DATABASE IF NOT EXISTS ivy_control;

CREATE TABLE IF NOT EXISTS ivy.otel_traces
(
    `TenantId` LowCardinality(String) DEFAULT ResourceAttributes['ivy.tenant_id'] CODEC(ZSTD(1)),
    `ProjectId` LowCardinality(String) DEFAULT ResourceAttributes['ivy.project_id'] CODEC(ZSTD(1)),
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
ORDER BY (TenantId, ProjectId, toStartOfHour(Timestamp), TraceId)
TTL toDateTime(Timestamp) + toIntervalDay({{RETENTION_DAYS}})
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- Tenant and project are set by ingest from the API key, replacing any
-- client-supplied `ivy.tenant_id` / `ivy.project_id`. Older schemas fell back to the client's attribute or 'default'.
ALTER TABLE ivy.otel_traces MODIFY COLUMN `TenantId` LowCardinality(String) DEFAULT ResourceAttributes['ivy.tenant_id'] CODEC(ZSTD(1));

CREATE TABLE IF NOT EXISTS ivy.invocations
(
    `tenant_id` LowCardinality(String),
    `project_id` LowCardinality(String),
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
    `http_route` String CODEC(ZSTD(1)),
    `http_status` UInt16,
    `error_type` LowCardinality(String),
    `error_message` String CODEC(ZSTD(1)),
    `error_frame` String CODEC(ZSTD(1)),
    `memory_used_mb` Float32,
    `memory_limit_mb` UInt32,
    `failure_phase` LowCardinality(String),
    `synthetic` Bool,
    `init_duration_ms` Float32,
    INDEX idx_trace_id trace_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_request_id request_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_http_path http_path TYPE ngrambf_v1(3, 4096, 3, 0) GRANULARITY 1,
    INDEX idx_error_message error_message TYPE ngrambf_v1(3, 8192, 3, 0) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, project_id, function, ts)
TTL toDateTime(ts) + toIntervalDay({{RETENTION_DAYS}})
SETTINGS ttl_only_drop_parts = 1;

-- Columns added after the first release; the view below is recreated so it fills them.
ALTER TABLE ivy.invocations ADD COLUMN IF NOT EXISTS `memory_limit_mb` UInt32 AFTER `memory_used_mb`;
ALTER TABLE ivy.invocations ADD COLUMN IF NOT EXISTS `failure_phase` LowCardinality(String) AFTER `memory_limit_mb`;
ALTER TABLE ivy.invocations ADD COLUMN IF NOT EXISTS `synthetic` Bool AFTER `failure_phase`;
ALTER TABLE ivy.invocations ADD COLUMN IF NOT EXISTS `init_duration_ms` Float32 AFTER `synthetic`;
ALTER TABLE ivy.invocations ADD COLUMN IF NOT EXISTS `error_frame` String CODEC(ZSTD(1)) AFTER `error_message`;
ALTER TABLE ivy.invocations ADD COLUMN IF NOT EXISTS `http_route` String CODEC(ZSTD(1)) AFTER `http_path`;

-- Dropped and recreated (rather than IF NOT EXISTS) so a re-run picks up changes to the query.
-- Spans inserted during the few milliseconds in between are not copied into `invocations`.
-- Update spans (`ivy.update`, late Lambda report data) never match: they carry no `ivy.invocation`.
DROP VIEW IF EXISTS ivy.invocations_mv;
CREATE MATERIALIZED VIEW ivy.invocations_mv TO ivy.invocations AS
WITH
    arrayFirstIndex(n -> n = 'exception', `Events.Name`) AS ex_idx,
    if(ex_idx > 0, `Events.Attributes`[ex_idx], map()) AS ex,
    StatusCode = 'Error' AS is_error,
    if(ResourceAttributes['faas.name'] != '', ResourceAttributes['faas.name'], ServiceName) AS fn,
    if(is_error, if(SpanAttributes['error.type'] != '', SpanAttributes['error.type'], ex['exception.type']), '') AS err_type,
    if(is_error, if(StatusMessage != '', StatusMessage, ex['exception.message']), '') AS err_message,
    -- The code location of the error, for the error group fingerprint (docs/implementation/error-grouping.md):
    -- `file:function` of the top in-app frame, without line and column, so a deploy doesn't split groups.
    -- JavaScript: the first `at …` frame outside node_modules, Node internals, the Lambda runtime and the Ivy layer.
    -- Python: the last `File "…", line N, in fn` outside packages and the runtime (tracebacks list the innermost last).
    splitByChar('\n', ex['exception.stacktrace']) AS stack_lines,
    arrayFirst(l -> match(l, '^[ \t]*at ') AND match(l, '/') AND NOT match(l, 'node_modules|node:|\\(internal/|/var/runtime/|/opt/nodejs/'), stack_lines) AS js_frame,
    extract(js_frame, '^[ \t]*at (?:async )?(.+?) \\(') AS js_fn,
    replaceRegexpAll(
        if(js_fn != '', extract(js_frame, '\\(([^()]*)\\)[ \t]*$'), extract(js_frame, '^[ \t]*at (?:async )?(.*)$')),
        '^file://|\\?[^:]*|(?::[0-9]+){1,2}$', '') AS js_file,
    arrayLast(l -> match(l, '^[ \t]*File "') AND NOT match(l, 'site-packages|dist-packages|/var/runtime/|/var/lang/'), stack_lines) AS py_frame,
    multiIf(
        js_file != '', concat(js_file, if(js_fn != '', concat(':', js_fn), '')),
        py_frame != '', concat(extract(py_frame, 'File "([^"]*)"'), ':', trimBoth(extract(py_frame, ', in (.*)$'))),
        '') AS err_frame
SELECT
    TenantId AS tenant_id,
    ProjectId AS project_id,
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
    SpanAttributes['http.route'] AS http_route,
    toUInt16OrZero(SpanAttributes['http.response.status_code']) AS http_status,
    err_type AS error_type,
    err_message AS error_message,
    if(is_error, err_frame, '') AS error_frame,
    toFloat32OrZero(SpanAttributes['ivy.memory_used_mb']) AS memory_used_mb,
    toUInt32(toUInt64OrZero(ResourceAttributes['faas.max_memory']) / 1048576) AS memory_limit_mb,
    SpanAttributes['ivy.failure.phase'] AS failure_phase,
    SpanAttributes['ivy.synthetic'] = 'true' AS synthetic,
    toFloat32OrZero(SpanAttributes['ivy.init_duration_ms']) AS init_duration_ms
FROM ivy.otel_traces
WHERE SpanAttributes['ivy.invocation'] = 'true' AND SpanAttributes['ivy.in_progress'] != 'true';

-- Error group fingerprints are computed at query time now (docs/implementation/error-grouping.md); the view used to
-- store one. Dropped after the view is replaced, so no insert writes to a missing column.
ALTER TABLE ivy.invocations DROP INDEX IF EXISTS idx_error_fingerprint;
ALTER TABLE ivy.invocations DROP COLUMN IF EXISTS `error_fingerprint`;

-- Long-running invocations the extension reported as in progress (`ivy.in_progress`, docs/implementation/layer.md).
-- Kept apart from `invocations`, so that table, its rollup and the trace count (billing) only ever see the final
-- invocation span. The list reads rows from here whose final span (same trace and span ID) is not in `invocations`
-- yet. A refresh replaces the row (newest `last_seen` wins).
CREATE TABLE IF NOT EXISTS ivy.invocations_in_progress
(
    `tenant_id` LowCardinality(String),
    `project_id` LowCardinality(String),
    `ts` DateTime64(3) CODEC(Delta(8), ZSTD(1)),
    `trace_id` String CODEC(ZSTD(1)),
    `span_id` String CODEC(ZSTD(1)),
    `function` LowCardinality(String),
    `region` LowCardinality(String),
    `cold_start` Bool,
    `request_id` String CODEC(ZSTD(1)),
    `trigger` LowCardinality(String),
    `memory_limit_mb` UInt32,
    `deadline` DateTime64(3),
    `last_seen` DateTime64(3)
)
ENGINE = ReplacingMergeTree(last_seen)
PARTITION BY toDate(ts)
ORDER BY (tenant_id, project_id, function, ts, span_id)
TTL toDateTime(ts) + toIntervalDay({{RETENTION_DAYS}})
SETTINGS ttl_only_drop_parts = 1;

DROP VIEW IF EXISTS ivy.invocations_in_progress_mv;
CREATE MATERIALIZED VIEW ivy.invocations_in_progress_mv TO ivy.invocations_in_progress AS
SELECT
    TenantId AS tenant_id,
    ProjectId AS project_id,
    toDateTime64(Timestamp, 3) AS ts,
    TraceId AS trace_id,
    SpanId AS span_id,
    if(ResourceAttributes['faas.name'] != '', ResourceAttributes['faas.name'], ServiceName) AS function,
    ResourceAttributes['cloud.region'] AS region,
    SpanAttributes['faas.coldstart'] = 'true' AS cold_start,
    SpanAttributes['faas.invocation_id'] AS request_id,
    if(SpanAttributes['ivy.trigger.source'] != '', SpanAttributes['ivy.trigger.source'], 'unknown') AS trigger,
    toUInt32(toUInt64OrZero(ResourceAttributes['faas.max_memory']) / 1048576) AS memory_limit_mb,
    fromUnixTimestamp64Milli(toInt64OrZero(SpanAttributes['ivy.deadline_ms'])) AS deadline,
    toDateTime64(Timestamp, 3) + toIntervalMillisecond(intDiv(Duration, 1000000)) AS last_seen
FROM ivy.otel_traces
WHERE SpanAttributes['ivy.invocation'] = 'true' AND SpanAttributes['ivy.in_progress'] = 'true';

CREATE TABLE IF NOT EXISTS ivy.invocations_hourly
(
    `tenant_id` LowCardinality(String),
    `project_id` LowCardinality(String),
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
ORDER BY (tenant_id, project_id, function, region, hour)
TTL hour + toIntervalDay({{RETENTION_DAYS}});

CREATE MATERIALIZED VIEW IF NOT EXISTS ivy.invocations_hourly_mv TO ivy.invocations_hourly AS
SELECT
    tenant_id,
    project_id,
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
GROUP BY tenant_id, project_id, hour, function, region;

-- Lambda throttles per function and minute, polled from CloudWatch by the API's auto-trace sync
-- (docs/implementation/auto-trace.md, "Throttles"). Re-polling a minute replaces its row.
CREATE TABLE IF NOT EXISTS ivy.function_throttles
(
    `tenant_id` LowCardinality(String),
    `project_id` LowCardinality(String),
    `function` LowCardinality(String),
    `region` LowCardinality(String),
    `minute` DateTime,
    `account_id` String,
    `throttles` UInt32,
    `updated_at` DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(minute)
ORDER BY (tenant_id, project_id, function, region, minute)
TTL minute + toIntervalDay({{RETENTION_DAYS}});

-- Defence in depth: when a query sets SQL_ivy_tenant (the API does for every query, see
-- packages/api/src/lib/clickhouse/scoped.ts), only that tenant's rows are visible, even if the
-- SQL forgot its tenant filter. Without the setting (ingest inserts, materialized views,
-- admin sessions) the policy lets everything through: a fail-closed policy would also filter
-- the rows materialized views read on insert.
CREATE ROW POLICY OR REPLACE ivy_tenant ON ivy.otel_traces AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_tenant', '') = '' OR TenantId = getSettingOrDefault('SQL_ivy_tenant', '') TO ALL;
CREATE ROW POLICY OR REPLACE ivy_tenant ON ivy.invocations AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_tenant', '') = '' OR tenant_id = getSettingOrDefault('SQL_ivy_tenant', '') TO ALL;
CREATE ROW POLICY OR REPLACE ivy_tenant ON ivy.invocations_hourly AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_tenant', '') = '' OR tenant_id = getSettingOrDefault('SQL_ivy_tenant', '') TO ALL;
CREATE ROW POLICY OR REPLACE ivy_tenant ON ivy.invocations_in_progress AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_tenant', '') = '' OR tenant_id = getSettingOrDefault('SQL_ivy_tenant', '') TO ALL;
CREATE ROW POLICY OR REPLACE ivy_tenant ON ivy.function_throttles AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_tenant', '') = '' OR tenant_id = getSettingOrDefault('SQL_ivy_tenant', '') TO ALL;
-- The same for projects: project-scoped API queries also set SQL_ivy_project. Workspace-wide
-- queries ("all projects") leave it unset and rely on the tenant policy.
CREATE ROW POLICY OR REPLACE ivy_project ON ivy.otel_traces AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_project', '') = '' OR ProjectId = getSettingOrDefault('SQL_ivy_project', '') TO ALL;
CREATE ROW POLICY OR REPLACE ivy_project ON ivy.invocations AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_project', '') = '' OR project_id = getSettingOrDefault('SQL_ivy_project', '') TO ALL;
CREATE ROW POLICY OR REPLACE ivy_project ON ivy.invocations_hourly AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_project', '') = '' OR project_id = getSettingOrDefault('SQL_ivy_project', '') TO ALL;
CREATE ROW POLICY OR REPLACE ivy_project ON ivy.invocations_in_progress AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_project', '') = '' OR project_id = getSettingOrDefault('SQL_ivy_project', '') TO ALL;
CREATE ROW POLICY OR REPLACE ivy_project ON ivy.function_throttles AS RESTRICTIVE
    USING getSettingOrDefault('SQL_ivy_project', '') = '' OR project_id = getSettingOrDefault('SQL_ivy_project', '') TO ALL;

-- Query page (docs/implementation/query.md): members run their own SQL against the views in `ivy_query`, as the
-- ClickHouse user `ivy_q_<workspace ID>` that the API creates with the role `ivy_query`. The role's row policies
-- give that user its own workspace's rows and nothing else; the views only add the project and time range the
-- page is looking at (the SQL_ivy_* settings, which the user may change: they are not a security boundary). Column
-- descriptions for the page and the MCP tool are in packages/spans/src/query.ts; keep them in sync.
CREATE DATABASE IF NOT EXISTS ivy_query;

CREATE OR REPLACE VIEW ivy_query.invocations SQL SECURITY INVOKER AS
SELECT
    i.ts AS ts,
    i.project_id AS project_id,
    i.function AS function,
    i.region AS region,
    i.status AS status,
    i.duration_ms AS duration_ms,
    i.cold_start AS cold_start,
    i.init_duration_ms AS init_duration_ms,
    i.memory_used_mb AS memory_used_mb,
    i.memory_limit_mb AS memory_limit_mb,
    i.trigger AS trigger,
    i.http_method AS http_method,
    if(i.http_route != '', i.http_route, i.http_path) AS http_route,
    i.http_path AS http_path,
    i.http_status AS http_status,
    i.error_type AS error_type,
    i.error_message AS error_message,
    i.failure_phase AS failure_phase,
    i.request_id AS request_id,
    i.trace_id AS trace_id,
    i.span_id AS span_id
FROM ivy.invocations AS i
WHERE (getSettingOrDefault('SQL_ivy_project', '') = '' OR i.project_id = getSettingOrDefault('SQL_ivy_project', ''))
    AND i.ts >= fromUnixTimestamp64Milli(toInt64OrZero(getSettingOrDefault('SQL_ivy_from_ms', '0')))
    AND i.ts < fromUnixTimestamp64Milli(toInt64OrZero(getSettingOrDefault('SQL_ivy_to_ms', '0')));

-- Update spans (late report data) and in-progress records are internal and left out.
CREATE OR REPLACE VIEW ivy_query.spans SQL SECURITY INVOKER AS
WITH
    if(SpanAttributes['db.system.name'] != '', SpanAttributes['db.system.name'], SpanAttributes['db.system']) AS db_sys,
    SpanAttributes['rpc.service'] AS rpc_service
SELECT
    toDateTime64(Timestamp, 3) AS ts,
    ProjectId AS project_id,
    TraceId AS trace_id,
    SpanId AS span_id,
    ParentSpanId AS parent_span_id,
    if(ResourceAttributes['faas.name'] != '', ResourceAttributes['faas.name'], ServiceName) AS function,
    SpanName AS name,
    lower(SpanKind) AS kind,
    multiIf(
        SpanAttributes['ivy.invocation'] = 'true', 'invocation',
        SpanAttributes['gen_ai.system'] != '' OR SpanAttributes['gen_ai.provider.name'] != '' OR SpanAttributes['gen_ai.request.model'] != ''
            OR SpanAttributes['openinference.span.kind'] != '' OR startsWith(SpanName, 'ai.') OR rpc_service = 'BedrockRuntime', 'llm',
        db_sys != '' OR rpc_service IN ('DynamoDB', 'RDSData'), 'database',
        SpanAttributes['rpc.system'] = 'aws-api', 'aws',
        SpanAttributes['http.request.method'] != '', 'http',
        'other') AS category,
    Duration / 1e6 AS duration_ms,
    multiIf(StatusCode = 'Error', 'error', StatusCode = 'Ok', 'ok', 'unset') AS status,
    StatusMessage AS status_message,
    greatest(toUInt64OrZero(SpanAttributes['ivy.collapsed.count']), 1) AS calls,
    rpc_service AS aws_service,
    SpanAttributes['rpc.method'] AS aws_operation,
    db_sys AS db_system,
    if(SpanAttributes['db.operation.name'] != '', SpanAttributes['db.operation.name'], SpanAttributes['db.operation']) AS db_operation,
    if(SpanAttributes['db.query.text'] != '', SpanAttributes['db.query.text'], SpanAttributes['db.statement']) AS db_statement,
    SpanAttributes['http.request.method'] AS http_method,
    SpanAttributes['url.full'] AS http_url,
    SpanAttributes['server.address'] AS http_host,
    toUInt16OrZero(SpanAttributes['http.response.status_code']) AS http_status,
    SpanAttributes AS attributes,
    ResourceAttributes AS resource_attributes
FROM ivy.otel_traces
WHERE (getSettingOrDefault('SQL_ivy_project', '') = '' OR ProjectId = getSettingOrDefault('SQL_ivy_project', ''))
    AND Timestamp >= fromUnixTimestamp64Milli(toInt64OrZero(getSettingOrDefault('SQL_ivy_from_ms', '0')))
    AND Timestamp < fromUnixTimestamp64Milli(toInt64OrZero(getSettingOrDefault('SQL_ivy_to_ms', '0')))
    AND SpanAttributes['ivy.update'] != 'true' AND SpanAttributes['ivy.in_progress'] != 'true';

-- `console.*` output: `log` events of invocation spans (span-conventions.md, "Logs").
CREATE OR REPLACE VIEW ivy_query.logs SQL SECURITY INVOKER AS
SELECT
    toDateTime64(event_ts, 3) AS ts,
    ProjectId AS project_id,
    TraceId AS trace_id,
    SpanId AS span_id,
    if(ResourceAttributes['faas.name'] != '', ResourceAttributes['faas.name'], ServiceName) AS function,
    event_attributes['log.severity'] AS level,
    event_attributes['log.message'] AS message
FROM ivy.otel_traces
ARRAY JOIN `Events.Timestamp` AS event_ts, `Events.Name` AS event_name, `Events.Attributes` AS event_attributes
WHERE (getSettingOrDefault('SQL_ivy_project', '') = '' OR ProjectId = getSettingOrDefault('SQL_ivy_project', ''))
    AND Timestamp >= fromUnixTimestamp64Milli(toInt64OrZero(getSettingOrDefault('SQL_ivy_from_ms', '0')))
    AND Timestamp < fromUnixTimestamp64Milli(toInt64OrZero(getSettingOrDefault('SQL_ivy_to_ms', '0')))
    AND event_name = 'log' AND SpanAttributes['ivy.invocation'] = 'true' AND SpanAttributes['ivy.in_progress'] != 'true';

-- The views run with the caller's rights (SQL SECURITY INVOKER), so the role reads the tables behind them, and the
-- tenant policies below apply. No other grants: no ivy_control, no system tables (select_from_system_db_requires_grant
-- is on in the server's default config), no table functions (url, file, s3, remote need grants of their own).
CREATE ROLE IF NOT EXISTS ivy_query;
GRANT SELECT ON ivy_query.* TO ivy_query;
GRANT SELECT ON ivy.otel_traces TO ivy_query;
GRANT SELECT ON ivy.invocations TO ivy_query;

-- The workspace is the user's name: ivy_q_<tenant ID>. Fails closed: any other name matches no tenant. On every span
-- table, also those the role can't read, so a later grant can't open one up.
CREATE ROW POLICY OR REPLACE ivy_query_tenant ON ivy.otel_traces AS RESTRICTIVE
    USING TenantId = replaceOne(currentUser(), 'ivy_q_', '') TO ivy_query;
CREATE ROW POLICY OR REPLACE ivy_query_tenant ON ivy.invocations AS RESTRICTIVE
    USING tenant_id = replaceOne(currentUser(), 'ivy_q_', '') TO ivy_query;
CREATE ROW POLICY OR REPLACE ivy_query_tenant ON ivy.invocations_hourly AS RESTRICTIVE
    USING tenant_id = replaceOne(currentUser(), 'ivy_q_', '') TO ivy_query;
CREATE ROW POLICY OR REPLACE ivy_query_tenant ON ivy.invocations_in_progress AS RESTRICTIVE
    USING tenant_id = replaceOne(currentUser(), 'ivy_q_', '') TO ivy_query;
CREATE ROW POLICY OR REPLACE ivy_query_tenant ON ivy.function_throttles AS RESTRICTIVE
    USING tenant_id = replaceOne(currentUser(), 'ivy_q_', '') TO ivy_query;

-- Read only, and limits a query can lower but not raise. Only the scope settings and limits marked
-- CHANGEABLE_IN_READONLY can be set at all (by the API or in the query's SETTINGS clause).
CREATE SETTINGS PROFILE OR REPLACE ivy_query SETTINGS
    readonly = 1 CONST,
    max_execution_time = 30 MAX 30 CHANGEABLE_IN_READONLY,
    max_rows_to_read = 1000000000 MAX 1000000000 CHANGEABLE_IN_READONLY,
    max_memory_usage = 2000000000 MAX 2000000000 CHANGEABLE_IN_READONLY,
    max_threads = 4 MAX 4 CHANGEABLE_IN_READONLY,
    max_result_rows = 10000 MAX 10000 CHANGEABLE_IN_READONLY,
    max_result_bytes = 10000000 MAX 10000000 CHANGEABLE_IN_READONLY,
    result_overflow_mode = 'break' CONST,
    max_concurrent_queries_for_user = 4 CONST,
    session_timezone = 'UTC' CHANGEABLE_IN_READONLY,
    SQL_ivy_project = '' CHANGEABLE_IN_READONLY,
    SQL_ivy_from_ms = '0' CHANGEABLE_IN_READONLY,
    SQL_ivy_to_ms = '0' CHANGEABLE_IN_READONLY;

-- Per workspace (one user each).
CREATE QUOTA OR REPLACE ivy_query KEYED BY user_name
    FOR INTERVAL 1 minute MAX queries = 60,
    FOR INTERVAL 1 hour MAX execution_time = 1800
    TO ivy_query;

-- Control plane. Small, mutable tables: every update inserts a full row, ReplacingMergeTree
-- keeps the newest version, reads use FINAL.

-- A tenant is a workspace (docs/implementation/workspaces-projects.md). `slug` is unique across
-- workspaces (checked by the API) and appears in URLs; `default` for the self-hosted tenant.
CREATE TABLE IF NOT EXISTS ivy_control.tenants
(
    `id` String,
    `slug` String DEFAULT '',
    `name` String,
    `shard_id` LowCardinality(String) DEFAULT 'shard-1',
    `created_at` DateTime64(3, 'UTC'),
    `updated_at` DateTime64(3, 'UTC'),
    `deleted` UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id;

-- Legacy: workspaces used to have a default project. Only read once at startup, to give keys without
-- a project that project explicitly ('' meant the project with the derived ID below). Not written.
ALTER TABLE ivy_control.tenants ADD COLUMN IF NOT EXISTS `default_project_id` String DEFAULT '' AFTER shard_id;

-- Projects group a workspace's functions and own its ingest keys. `slug` is unique per workspace.
-- Projects Ivy creates itself (the self-hosted "Default" project, and the first project of workspaces
-- created before workspaces started empty) have an ID derived from the tenant ID:
-- prj_ + the first 21 hex characters of sha256('ivy-default-project:' || tenant_id).
CREATE TABLE IF NOT EXISTS ivy_control.projects
(
    `tenant_id` String,
    `id` String,
    `slug` String,
    `name` String,
    `archived` UInt8 DEFAULT 0,
    `created_at` DateTime64(3, 'UTC'),
    `updated_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, id);

-- Keys are stored as sha256(key) plus a display prefix. `encrypted_key` is only set for keys Ivy
-- hands out itself (the per-tenant auto-trace key), encrypted with IVY_SECRET_KEY.
-- Every key belongs to a project. Keys with an empty `project_id` (from before projects) are given
-- one at startup and rejected until then.
CREATE TABLE IF NOT EXISTS ivy_control.api_keys
(
    `tenant_id` String,
    `project_id` String DEFAULT '',
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

-- Who can use a tenant: the OIDC subject (`sub`) of a signed-in user (docs/implementation/auth.md).
-- Looked up by `sub` on sign-in, hence the bloom filter.
CREATE TABLE IF NOT EXISTS ivy_control.tenant_members
(
    `tenant_id` String,
    `sub` String,
    `email` String DEFAULT '',
    `role` LowCardinality(String) DEFAULT 'member',
    `created_at` DateTime64(3, 'UTC'),
    `updated_at` DateTime64(3, 'UTC'),
    `deleted` UInt8 DEFAULT 0,
    INDEX idx_sub sub TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, sub);

-- Workspace invitations. Only sha256(token) is stored; tokens are single use and expire.
CREATE TABLE IF NOT EXISTS ivy_control.invitations
(
    `tenant_id` String,
    `id` String,
    `email` String,
    `role` LowCardinality(String),
    `token_hash` String,
    `invited_by` String,
    `invited_by_email` String DEFAULT '',
    `created_at` DateTime64(3, 'UTC'),
    `expires_at` DateTime64(3, 'UTC'),
    `accepted_at` Nullable(DateTime64(3, 'UTC')),
    `accepted_by` String DEFAULT '',
    `revoked_at` Nullable(DateTime64(3, 'UTC')),
    `updated_at` DateTime64(3, 'UTC'),
    INDEX idx_token_hash token_hash TYPE bloom_filter(0.001) GRANULARITY 1
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
    -- `default_project_id`: legacy (the UI's preselected project, removed), written as '' and unused.
    -- `reviewed_at`: functions first seen after it count as "new".
    `default_project_id` String DEFAULT '',
    `reviewed_at` DateTime64(3, 'UTC') DEFAULT 0,
    `regions` Array(LowCardinality(String)),
    `all_regions` Bool,
    `status` LowCardinality(String),
    `error` String,
    `created_at` DateTime64(3, 'UTC'),
    `verified_at` DateTime64(3, 'UTC'),
    `last_sync_at` DateTime64(3, 'UTC'),
    `throttle_metrics` Bool DEFAULT true,
    `throttle_status` LowCardinality(String) DEFAULT '',
    `throttles_polled_to` DateTime64(3, 'UTC') DEFAULT 0,
    `updated_at` DateTime64(3, 'UTC'),
    `deleted` UInt8
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, id);

ALTER TABLE ivy_control.aws_accounts ADD COLUMN IF NOT EXISTS `throttle_metrics` Bool DEFAULT true AFTER last_sync_at;
ALTER TABLE ivy_control.aws_accounts ADD COLUMN IF NOT EXISTS `throttle_status` LowCardinality(String) DEFAULT '' AFTER throttle_metrics;
ALTER TABLE ivy_control.aws_accounts ADD COLUMN IF NOT EXISTS `throttles_polled_to` DateTime64(3, 'UTC') DEFAULT 0 AFTER throttle_status;

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
    `project_id` String DEFAULT '',
    `project_source` LowCardinality(String) DEFAULT '',
    `rule_id` String DEFAULT '',
    -- With state 'conflict': 'wrapper', 'layers' or 'reapplied' (another tracer set its wrapper back after a
    -- forced install). `wrapper`: the other tracer's exec wrapper (in the way, or replaced by a forced install).
    `conflict` LowCardinality(String) DEFAULT '',
    `wrapper` String DEFAULT '',
    `stack` String DEFAULT '',
    `tags` Map(String, String) DEFAULT map(),
    `last_modified` String DEFAULT '',
    `first_seen_at` DateTime64(3, 'UTC') DEFAULT now64(3),
    `updated_at` DateTime64(3, 'UTC'),
    `deleted` UInt8
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, account_id, region, function_name);

ALTER TABLE ivy_control.aws_functions ADD COLUMN IF NOT EXISTS `conflict` LowCardinality(String) DEFAULT '' AFTER rule_id;
ALTER TABLE ivy_control.aws_functions ADD COLUMN IF NOT EXISTS `wrapper` String DEFAULT '' AFTER conflict;

CREATE TABLE IF NOT EXISTS ivy_control.aws_function_settings
(
    `tenant_id` LowCardinality(String),
    `account_id` String,
    `region` LowCardinality(String),
    `function_name` String,
    -- The manual choice: `mode` '' (follow the rules), 'trace' (into `project_id`) or 'exclude'.
    -- `tracing_enabled` (false = exclude) is kept for rows written before modes existed.
    -- `force`: replace another tracer's AWS_LAMBDA_EXEC_WRAPPER when the function is traced.
    `tracing_enabled` Bool,
    `mode` LowCardinality(String) DEFAULT '',
    `project_id` String DEFAULT '',
    `force` Bool DEFAULT false,
    `updated_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, account_id, region, function_name);

ALTER TABLE ivy_control.aws_function_settings ADD COLUMN IF NOT EXISTS `force` Bool DEFAULT false AFTER project_id;

-- Auto-trace rules of a workspace (docs/implementation/auto-trace.md): which functions are traced,
-- and into which project. Evaluated in `position` order, first enabled match wins. Every non-empty
-- matcher field must match: `account_id` and `region` exactly, `stack` (the aws:cloudformation:stack-name
-- tag) and `name` as globs (`*`, `?`), `tag` as `key=value` (value may be a glob) or just `key`.
CREATE TABLE IF NOT EXISTS ivy_control.aws_project_rules
(
    `tenant_id` LowCardinality(String),
    `id` String,
    `position` UInt32,
    `account_id` String DEFAULT '',
    `region` String DEFAULT '',
    `stack` String DEFAULT '',
    `name` String DEFAULT '',
    `tag` String DEFAULT '',
    `project_id` String,
    `enabled` Bool DEFAULT true,
    `created_at` DateTime64(3, 'UTC'),
    `updated_at` DateTime64(3, 'UTC'),
    `deleted` UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, id);

-- Per-workspace ingest limits (docs/implementation/limits.md). No row means unlimited; a NULL quota
-- is unlimited too.
CREATE TABLE IF NOT EXISTS ivy_control.workspace_limits
(
    `tenant_id` String,
    `plan` String DEFAULT '',
    `monthly_trace_quota` Nullable(UInt64),
    `over_quota` LowCardinality(String) DEFAULT 'allow',
    `updated_at` DateTime64(3, 'UTC'),
    `deleted` UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY tenant_id;

-- Alerts (docs/implementation/alerts.md).

-- Per-project alert settings. No row means the defaults: Slack on (once a channel is connected),
-- first seen, then at most every 60 minutes or every 100 occurrences, throttles off.
CREATE TABLE IF NOT EXISTS ivy_control.alert_settings
(
    `tenant_id` String,
    `project_id` String,
    `slack_enabled` Bool DEFAULT true,
    `interval_minutes` UInt32 DEFAULT 60,
    `every_occurrences` UInt32 DEFAULT 100,
    `include_throttles` Bool DEFAULT false,
    `updated_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, project_id);

-- Slack channels of a project (OAuth v2, scope incoming-webhook). The webhook URL is encrypted with
-- IVY_SECRET_KEY. `status` 'broken' after Slack rejected the webhook (revoked, channel archived).
CREATE TABLE IF NOT EXISTS ivy_control.slack_integrations
(
    `tenant_id` String,
    `project_id` String,
    `id` String,
    `team_id` String,
    `team_name` String,
    `channel` String,
    `channel_id` String,
    `encrypted_webhook_url` String,
    `configuration_url` String DEFAULT '',
    `status` LowCardinality(String) DEFAULT 'ok',
    `error` String DEFAULT '',
    `created_by` String DEFAULT '',
    `created_at` DateTime64(3, 'UTC'),
    `updated_at` DateTime64(3, 'UTC'),
    `deleted` UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, project_id, id);

-- What was last sent to Slack per error group: first-seen detection and the throttle.
CREATE TABLE IF NOT EXISTS ivy_control.alert_state
(
    `tenant_id` String,
    `project_id` String,
    `fingerprint` String,
    `first_notified_at` DateTime64(3, 'UTC'),
    `last_notified_at` DateTime64(3, 'UTC'),
    `occurrences_at_last_notify` UInt64,
    `updated_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, project_id, fingerprint);

-- Weekly email digest: per-workspace switch (no row = on).
CREATE TABLE IF NOT EXISTS ivy_control.digest_settings
(
    `tenant_id` String,
    `enabled` Bool DEFAULT true,
    `updated_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY tenant_id;

-- A user's digest choice per workspace (no row = subscribed). `sub` is the OIDC subject, or
-- `email:<address>` for IVY_DIGEST_TO recipients. Also the recipient list in single-workspace mode.
CREATE TABLE IF NOT EXISTS ivy_control.notification_prefs
(
    `tenant_id` String,
    `sub` String,
    `email` String DEFAULT '',
    `digest` Bool DEFAULT true,
    `updated_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, sub);

-- Digest sends, one row per workspace and week (Monday, UTC): makes the weekly send idempotent.
CREATE TABLE IF NOT EXISTS ivy_control.digest_sends
(
    `tenant_id` String,
    `week` Date,
    `recipients` UInt32,
    `sent_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(sent_at)
ORDER BY (tenant_id, week);

-- Single-instance leases for background jobs (alert evaluator, digest) across API processes.
CREATE TABLE IF NOT EXISTS ivy_control.job_leases
(
    `name` String,
    `holder` String,
    `since` DateTime64(3, 'UTC'),
    `expires_at` DateTime64(3, 'UTC'),
    `updated_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (name, holder)
TTL toDateTime(expires_at) + INTERVAL 1 DAY;

-- Saved queries of the Query page, shared by the workspace's members (docs/implementation/query.md). The defaults
-- (packages/spans/src/query.ts) are saved into each workspace under IDs derived from their keys, once.
CREATE TABLE IF NOT EXISTS ivy_control.saved_queries
(
    `tenant_id` String,
    `id` String,
    `name` String,
    `sql` String,
    `created_by` String DEFAULT '',
    `created_at` DateTime64(3, 'UTC'),
    `updated_by` String DEFAULT '',
    `updated_at` DateTime64(3, 'UTC'),
    `deleted` UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, id);
