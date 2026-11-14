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

-- Tenant and project are set by the collector from the ingest router's headers, which replace any
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
    `http_status` UInt16,
    `error_type` LowCardinality(String),
    `error_message` String CODEC(ZSTD(1)),
    `error_fingerprint` String,
    `memory_used_mb` Float32,
    `memory_limit_mb` UInt32,
    `failure_phase` LowCardinality(String),
    `synthetic` Bool,
    `init_duration_ms` Float32,
    INDEX idx_trace_id trace_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_request_id request_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_http_path http_path TYPE ngrambf_v1(3, 4096, 3, 0) GRANULARITY 1,
    INDEX idx_error_message error_message TYPE ngrambf_v1(3, 8192, 3, 0) GRANULARITY 1,
    INDEX idx_error_fingerprint error_fingerprint TYPE bloom_filter(0.01) GRANULARITY 1
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
    replaceRegexpAll(
        replaceRegexpAll(
            replaceRegexpAll(err_message, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<uuid>'),
            '\\b[0-9a-fA-F]{16,}\\b', '<hex>'),
        '\\d+(\\.\\d+)?', '<n>') AS err_normalized
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
    toUInt16OrZero(SpanAttributes['http.response.status_code']) AS http_status,
    err_type AS error_type,
    err_message AS error_message,
    if(is_error, lower(hex(cityHash64(fn, err_type, err_normalized))), '') AS error_fingerprint,
    toFloat32OrZero(SpanAttributes['ivy.memory_used_mb']) AS memory_used_mb,
    toUInt32(toUInt64OrZero(ResourceAttributes['faas.max_memory']) / 1048576) AS memory_limit_mb,
    SpanAttributes['ivy.failure.phase'] AS failure_phase,
    SpanAttributes['ivy.synthetic'] = 'true' AS synthetic,
    toFloat32OrZero(SpanAttributes['ivy.init_duration_ms']) AS init_duration_ms
FROM ivy.otel_traces
WHERE SpanAttributes['ivy.invocation'] = 'true' AND SpanAttributes['ivy.in_progress'] != 'true';

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
-- SQL forgot its tenant filter. Without the setting (collector inserts, materialized views,
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

-- The workspace's default project (keys without a project and auto-traced functions without one go
-- there). '' means the project whose ID is derived from the tenant ID (see below).
ALTER TABLE ivy_control.tenants ADD COLUMN IF NOT EXISTS `default_project_id` String DEFAULT '' AFTER shard_id;

-- Projects group a workspace's functions and own its ingest keys. `slug` is unique per workspace.
-- Every workspace starts with a project whose ID is derived from the tenant ID (its first default project):
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
-- Keys belong to a project; an empty `project_id` means the workspace's current default project.
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
    -- The project the UI preselects; `reviewed_at`: functions first seen after it count as "new".
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
    `stack` String DEFAULT '',
    `tags` Map(String, String) DEFAULT map(),
    `last_modified` String DEFAULT '',
    `first_seen_at` DateTime64(3, 'UTC') DEFAULT now64(3),
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
    -- The manual choice: `mode` '' (follow the rules), 'trace' (into `project_id`) or 'exclude'.
    -- `tracing_enabled` (false = exclude) is kept for rows written before modes existed.
    `tracing_enabled` Bool,
    `mode` LowCardinality(String) DEFAULT '',
    `project_id` String DEFAULT '',
    `updated_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, account_id, region, function_name);

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
