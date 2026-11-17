// Direct imports: vite.config.ts loads this file with Node, which resolves no `.js` -> `.ts` imports.
import { DEFAULT_QUERIES, type QueryResult } from "@ivy/spans/query";
import type { Invocation } from "../api/types.ts";

/** A saved query of the mock workspace (`/api/w/:ws/queries`). */
export interface MockSavedQuery {
  id: string;
  name: string;
  sql: string;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export function defaultSavedQueries(): MockSavedQuery[] {
  const at = new Date(Date.now() - 86_400_000).toISOString();
  return DEFAULT_QUERIES.map((q) => ({ id: `qry_default_${q.key}`, name: q.name, sql: q.sql, created_by: null, created_at: at, updated_by: null, updated_at: at }));
}

type Row = Invocation & { project_id?: string };

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
};

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return groups;
}

const stats = (rows: number) => ({ rows_read: rows * 37, bytes_read: rows * 4096, elapsed_ms: 40 + (rows % 60) });

/**
 * The mock server can't run SQL. It answers the default queries from the mock invocations, any other query over
 * `invocations` with the latest rows, and everything else with ClickHouse-like errors.
 */
export function mockQuery(sql: string, pool: Row[]): { status: number; body: QueryResult | { error: string } } {
  const text = sql.trim().replace(/[;\s]+$/, "");
  if (!text) return { status: 400, body: { error: "The query is empty" } };
  if (/\bFORMAT\s+\w+\s*$/i.test(text)) return { status: 400, body: { error: "Remove the FORMAT clause: results are always returned as a table." } };
  const preset = DEFAULT_QUERIES.find((q) => q.sql === text)?.key;
  const ok = (columns: [string, string][], rows: unknown[][]): { status: number; body: QueryResult } => ({
    status: 200,
    body: { columns: columns.map(([name, type]) => ({ name, type })), rows, truncated: false, stats: stats(pool.length) },
  });

  if (preset === "slowest-routes") {
    const http = pool.filter((r) => r.http_path);
    const rows = [...groupBy(http, (r) => `${r.http_method} ${r.http_path}`).values()].map((g) => {
      const d = g.map((r) => r.duration_ms);
      return [g[0].http_method, g[0].http_path, g.length, Math.round(quantile(d, 0.5)), Math.round(quantile(d, 0.95)), Math.round(Math.max(...d))];
    });
    rows.sort((a, b) => Number(b[4]) - Number(a[4]));
    return ok([["http_method", "LowCardinality(String)"], ["http_route", "String"], ["requests", "UInt64"], ["p50_ms", "Float64"], ["p95_ms", "Float64"], ["max_ms", "Float64"]], rows.slice(0, 50));
  }
  if (preset === "many-db-calls") {
    const rows = pool.slice(0, 6).map((r, i) => [r.trace_id, r.function, r.ts.replace("T", " ").replace("Z", ""), 184 - i * 23]);
    return ok([["trace_id", "String"], ["function", "String"], ["started", "DateTime64(3)"], ["db_calls", "UInt64"]], rows);
  }
  if (preset === "slowest-aws-calls") {
    return ok(
      [["aws_service", "String"], ["aws_operation", "String"], ["requests", "UInt64"], ["p95_ms", "Float64"], ["errors", "UInt64"]],
      [["S3", "PutObject", 412, 188, 0], ["DynamoDB", "Query", 2930, 41, 3], ["SQS", "SendMessage", 1204, 22, 0], ["DynamoDB", "GetItem", 8811, 12, 1]],
    );
  }
  if (preset === "cold-starts") {
    const rows = [...groupBy(pool, (r) => r.function).values()].map((g) => {
      const cold = g.filter((r) => r.cold_start);
      const init = cold.map((r) => r.init_duration_ms ?? 0);
      return [g[0].function, g.length, cold.length, Math.round((1000 * cold.length) / g.length) / 10, init.length ? Math.round(init.reduce((a, b) => a + b, 0) / init.length) : null];
    });
    rows.sort((a, b) => Number(b[2]) - Number(a[2]));
    return ok([["function", "String"], ["invocations", "UInt64"], ["cold_starts", "UInt64"], ["cold_start_pct", "Float64"], ["avg_init_ms", "Nullable(Float64)"]], rows);
  }
  if (preset === "error-logs") {
    const rows = pool.filter((r) => r.status === "error").slice(0, 100).map((r) => [r.ts.replace("T", " ").replace("Z", ""), r.function, r.error_message ?? "", r.trace_id]);
    return ok([["ts", "DateTime64(3)"], ["function", "String"], ["message", "String"], ["trace_id", "String"]], rows);
  }
  if (/\bfrom\s+invocations\b/i.test(text)) {
    const rows = pool.slice(0, 100).map((r) => [r.ts.replace("T", " ").replace("Z", ""), r.project_id ?? "", r.function, r.status, r.duration_ms, r.trace_id]);
    return ok([["ts", "DateTime64(3)"], ["project_id", "String"], ["function", "String"], ["status", "String"], ["duration_ms", "Float64"], ["trace_id", "String"]], rows);
  }
  const table = /\bfrom\s+(\w+)/i.exec(text)?.[1];
  if (table && !["spans", "logs"].includes(table)) {
    return { status: 400, body: { error: `Unknown table expression identifier '${table}' in scope ${text.slice(0, 80)}.` } };
  }
  return { status: 400, body: { error: "The mock server only fakes the default queries and SELECTs over invocations." } };
}
