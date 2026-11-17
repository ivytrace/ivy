/**
 * The tables of the Query page: views in the `ivy_query` ClickHouse database (deploy/clickhouse/schema.sql) that
 * workspace members query with their own SQL. Shared by the dashboard (schema browser, autocomplete), the API
 * (default saved queries) and the MCP `run_query` tool. See docs/implementation/query.md.
 */

export interface QueryColumn {
  name: string;
  type: string;
  description: string;
}

export interface QueryTable {
  name: string;
  description: string;
  columns: QueryColumn[];
}

const col = (name: string, type: string, description: string): QueryColumn => ({ name, type, description });

const scope = [
  col("ts", "DateTime64(3)", "Start time (UTC)."),
  col("project_id", "String", "Project ID (prj_…)."),
];

export const QUERY_TABLES: QueryTable[] = [
  {
    name: "invocations",
    description: "One row per Lambda invocation.",
    columns: [
      ...scope,
      col("function", "String", "Lambda function name."),
      col("region", "String", "AWS region."),
      col("status", "String", "'ok' or 'error'."),
      col("duration_ms", "Float64", "Duration in milliseconds."),
      col("cold_start", "Bool", "Whether this was a cold start."),
      col("init_duration_ms", "Float32", "Init phase duration of a cold start, else 0."),
      col("memory_used_mb", "Float32", "Memory used (MB), 0 when unknown."),
      col("memory_limit_mb", "UInt32", "Configured memory (MB), 0 when unknown."),
      col("trigger", "String", "Event source, e.g. 'aws:apigateway', 'aws:sqs', 'aws:scheduled', 'unknown'."),
      col("http_method", "String", "HTTP triggers: request method."),
      col("http_route", "String", "HTTP triggers: route template like '/orders/{id}' when the trigger provides one, else the path."),
      col("http_path", "String", "HTTP triggers: request path."),
      col("http_status", "UInt16", "HTTP triggers: response status, 0 when none."),
      col("error_type", "String", "Error type of a failed invocation, e.g. 'TypeError', 'Sandbox.Timedout'."),
      col("error_message", "String", "Error message of a failed invocation."),
      col("failure_phase", "String", "'init' or 'invoke' for failures outside the handler (crash, timeout, out of memory), else ''."),
      col("request_id", "String", "AWS request ID."),
      col("trace_id", "String", "Trace ID: links to the trace."),
      col("span_id", "String", "Span ID of the invocation span."),
    ],
  },
  {
    name: "spans",
    description: "Every span: the invocation span and the calls it made (AWS SDK, HTTP, database, LLM, your own spans).",
    columns: [
      ...scope,
      col("trace_id", "String", "Trace ID (one trace is one invocation)."),
      col("span_id", "String", "Span ID."),
      col("parent_span_id", "String", "Parent span ID, '' for the invocation span."),
      col("function", "String", "Lambda function name."),
      col("name", "String", "Span name, e.g. 'DynamoDB.GetItem', 'POST api.stripe.com'."),
      col("kind", "String", "'server', 'client', 'consumer', 'producer' or 'internal'."),
      col("category", "String", "'invocation', 'database' (DynamoDB, db.system), 'llm', 'aws' (other AWS SDK calls), 'http' or 'other'."),
      col("duration_ms", "Float64", "Duration in milliseconds. For summary spans, from the first to the last collapsed call."),
      col("status", "String", "'ok', 'error' or 'unset'."),
      col("status_message", "String", "Error message of a failed span."),
      col("calls", "UInt64", "Calls the span stands for: 1, or the number of calls a summary span collapsed. Count calls with sum(calls)."),
      col("aws_service", "String", "AWS SDK calls: service, e.g. 'DynamoDB', 'S3', 'SQS'."),
      col("aws_operation", "String", "AWS SDK calls: operation, e.g. 'GetItem'."),
      col("db_system", "String", "Database spans: db.system, e.g. 'postgresql', 'redis'."),
      col("db_operation", "String", "Database spans: operation, e.g. 'SELECT'."),
      col("db_statement", "String", "Database spans: query text."),
      col("http_method", "String", "HTTP calls (and HTTP-triggered invocations): request method."),
      col("http_url", "String", "HTTP calls: full URL."),
      col("http_host", "String", "HTTP calls: host."),
      col("http_status", "UInt16", "HTTP response status, 0 when none."),
      col("attributes", "Map(String, String)", "All span attributes, e.g. attributes['aws.dynamodb.table_names']."),
      col("resource_attributes", "Map(String, String)", "Resource attributes of the function, e.g. resource_attributes['cloud.account.id']."),
    ],
  },
  {
    name: "logs",
    description: "Log lines (console.* output) of invocations.",
    columns: [
      col("ts", "DateTime64(3)", "Time of the log line (UTC)."),
      col("project_id", "String", "Project ID (prj_…)."),
      col("trace_id", "String", "Trace ID of the invocation."),
      col("span_id", "String", "Span ID of the invocation span."),
      col("function", "String", "Lambda function name."),
      col("level", "String", "'debug', 'info', 'warn' or 'error': a JSON line's own level, else the console method's."),
      col("message", "String", "The log line (at most 4 KB). JSON lines: JSONExtractString(message, 'key')."),
    ],
  },
];

export interface DefaultQuery {
  /** Stable key: default queries are saved into each workspace under an ID derived from it. */
  key: string;
  name: string;
  sql: string;
}

export const DEFAULT_QUERIES: DefaultQuery[] = [
  {
    key: "slowest-routes",
    name: "Slowest API routes",
    sql: `SELECT
  http_method,
  http_route,
  count() AS requests,
  round(quantile(0.5)(duration_ms)) AS p50_ms,
  round(quantile(0.95)(duration_ms)) AS p95_ms,
  round(max(duration_ms)) AS max_ms
FROM invocations
WHERE http_route != ''
GROUP BY http_method, http_route
ORDER BY p95_ms DESC
LIMIT 50`,
  },
  {
    key: "many-db-calls",
    name: "Invocations with 30+ database calls",
    sql: `SELECT
  trace_id,
  any(function) AS function,
  min(ts) AS started,
  sum(calls) AS db_calls
FROM spans
WHERE category = 'database'
GROUP BY trace_id
HAVING db_calls >= 30
ORDER BY db_calls DESC
LIMIT 100`,
  },
  {
    key: "slowest-aws-calls",
    name: "Slowest AWS calls",
    sql: `-- Summary spans (calls > 1) are left out: their duration covers many calls.
SELECT
  aws_service,
  aws_operation,
  count() AS requests,
  round(quantile(0.95)(duration_ms)) AS p95_ms,
  countIf(status = 'error') AS errors
FROM spans
WHERE aws_service != '' AND calls = 1
GROUP BY aws_service, aws_operation
ORDER BY p95_ms DESC
LIMIT 50`,
  },
  {
    key: "cold-starts",
    name: "Cold starts per function",
    sql: `SELECT
  function,
  count() AS invocations,
  countIf(cold_start) AS cold_starts,
  round(100 * cold_starts / invocations, 1) AS cold_start_pct,
  round(avgIf(init_duration_ms, cold_start)) AS avg_init_ms
FROM invocations
GROUP BY function
ORDER BY cold_starts DESC`,
  },
  {
    key: "error-logs",
    name: "Recent error logs",
    sql: `SELECT ts, function, message, trace_id
FROM logs
WHERE level = 'error'
ORDER BY ts DESC
LIMIT 100`,
  },
];

/** What a query returns (`POST …/query`, the MCP `run_query` tool). */
export interface QueryResult {
  columns: { name: string; type: string }[];
  /** One array per row, in column order (ClickHouse's JSON values: numbers, strings, arrays, objects for maps). */
  rows: unknown[][];
  /** More rows came back than were asked for; only the first ones are in `rows`. */
  truncated: boolean;
  stats: { rows_read: number; bytes_read: number; elapsed_ms: number };
}
