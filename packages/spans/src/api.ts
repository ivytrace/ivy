import type { FailureKind } from "./failures.js";

/** Response shapes of the list endpoints (docs/implementation/api.md), shared by the formatters and the MCP. */

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
  /** Memory limit of the function (from the `faas.max_memory` resource attribute). */
  memory_limit_mb: number | null;
  /** `init` or `invoke` for failures outside the handler, reported by the extension (Telemetry API). */
  failure_phase: "init" | "invoke" | null;
  /** Label-friendly kind of a failure outside the handler (`failureLabel`); null for handler errors. */
  failure_kind: FailureKind | null;
  /** The extension created this invocation span itself: the tracer reported nothing (init failure, crash). */
  synthetic: boolean;
  init_duration_ms: number | null;
}

export interface ErrorGroup {
  fingerprint: string;
  function: string;
  error_type: string;
  error_message: string;
  count: number;
  first_seen: string;
  last_seen: string;
  /** null for the synthetic Throttled group: throttled requests never reach the function. */
  sample_trace_id: string | null;
  /** "throttle": one synthetic group per function counting Lambda throttles (error_type "Throttled"). */
  kind?: "error" | "throttle";
  failure_kind: FailureKind | null;
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
  last_invoked: string | null;
  /** Invocations Lambda rejected (CloudWatch Throttles); they never reached the function. */
  throttles?: number;
}
