export type { Span, SpanEvent, Trace } from "../spans/types.ts";

export interface AuthSettings {
  enabled: true;
  issuer: string;
  clientId: string;
  audience: string;
  scopes: string;
}

export interface Config {
  version: string;
  auth: AuthSettings | { enabled: false };
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
  /** null when the function was only throttled in the range. */
  last_invoked: string | null;
  /** Requests Lambda rejected (CloudWatch Throttles); they never reached the function. */
  throttles: number;
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
  /** null for the synthetic Throttled group (no trace). */
  sample_trace_id: string | null;
  kind: "error" | "throttle";
}

export interface TimeseriesPoint {
  ts: string;
  invocations: number;
  errors: number;
  p95_ms: number;
  throttles: number;
}

export interface ListResponse<T> {
  items: T[];
}

export interface InvocationsResponse extends ListResponse<Invocation> {
  next_cursor: string | null;
}

export type Since = "15m" | "1h" | "24h" | "7d";

export type TimeRange = { since: Since } | { from: string; to: string };

export type TraceState = "traced" | "opted_out" | "unsupported" | "conflict" | "error" | "pending";

export type AwsAccountStatus = "pending" | "connected" | "error";

export interface AwsSetup {
  principal_arn: string | null;
  template_url: string | null;
  events_url: string | null;
  public_url: string | null;
  ingest_endpoint: string | null;
  layer_sha256: string | null;
  default_region: string;
  regions: string[];
  sync_interval_seconds: number;
  issues: string[];
}

export interface AwsAccount {
  id: string;
  name: string;
  account_id: string;
  role_arn: string;
  external_id: string;
  stack_name: string;
  stack_region: string;
  regions: string[];
  all_regions: boolean;
  status: AwsAccountStatus;
  error: string | null;
  created_at: string | null;
  verified_at: string | null;
  last_sync_at: string | null;
  syncing: boolean;
  throttle_metrics: boolean;
  throttle_status: "ok" | "missing_permission" | "error" | null;
  counts: Record<TraceState | "total", number>;
  quick_create_url: string | null;
  template_download_url: string;
}

export interface AwsFunction {
  account_id: string;
  region: string;
  name: string;
  arn: string;
  runtime: string;
  state: TraceState;
  reason: string | null;
  tracing_enabled: boolean;
  updated_at: string;
}

export interface VerifyResponse {
  verified: boolean;
  account: AwsAccount;
}

export interface TracingResponse {
  applied: boolean;
  error: string | null;
  function: AwsFunction | null;
}
