export type { Span, SpanEvent, Trace } from "../spans/types.ts";

export interface Config {
  version: string;
  auth: { enabled: boolean };
}

export interface FunctionSummary {
  name: string;
  region: string;
  invocations: number;
  errors: number;
  error_rate: number;
  cold_starts: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  last_invoked: string;
}

export interface Invocation {
  trace_id: string;
  span_id: string;
  ts: string;
  function: string;
  region: string;
  status: "ok" | "error";
  duration_ms: number;
  cold_start: boolean;
  request_id: string;
  trigger: string;
  http_method: string | null;
  http_path: string | null;
  http_status: number | null;
  error_type: string | null;
  error_message: string | null;
  memory_used_mb: number | null;
}

export interface ErrorGroup {
  fingerprint: string;
  function: string;
  error_type: string;
  error_message: string;
  count: number;
  first_seen: string;
  last_seen: string;
  sample_trace_id: string;
}

export interface TimeseriesPoint {
  ts: string;
  invocations: number;
  errors: number;
  p95_ms: number;
}

export interface ListResponse<T> {
  items: T[];
}

export interface InvocationsResponse extends ListResponse<Invocation> {
  next_cursor: string | null;
}

export type Since = "15m" | "1h" | "24h" | "7d";

export type TimeRange = { since: Since } | { from: string; to: string };
