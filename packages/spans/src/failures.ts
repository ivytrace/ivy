import type { Span } from "./types.js";

/**
 * Failures outside the handler, reported by the Lambda extension from the Telemetry API
 * (docs/implementation/platform-failures.md). `null` for ordinary handler errors.
 */
export type FailureKind = "init_failed" | "out_of_memory" | "timed_out" | "crashed";

const INIT_ERROR_TYPES = new Set([
  "Runtime.ImportModuleError",
  "Runtime.HandlerNotFound",
  "Runtime.UserCodeSyntaxError",
  "Runtime.MalformedHandlerName",
]);
const TIMEOUT_TYPES = new Set(["Sandbox.Timedout", "Timeout"]);
const CRASH_TYPES = new Set(["Runtime.ExitError", "Runtime.Unknown"]);

export function failureKind(errorType: string | null | undefined, phase: string | null | undefined): FailureKind | null {
  if (phase === "init" || (errorType && INIT_ERROR_TYPES.has(errorType))) return "init_failed";
  if (errorType === "Runtime.OutOfMemory") return "out_of_memory";
  if (errorType && TIMEOUT_TYPES.has(errorType)) return "timed_out";
  if (phase === "invoke" || (errorType && CRASH_TYPES.has(errorType))) return "crashed";
  return null;
}

export const FAILURE_LABELS: Record<FailureKind, string> = {
  init_failed: "Init failed",
  out_of_memory: "Out of memory",
  timed_out: "Timed out",
  crashed: "Crashed",
};

export const failureLabel = (kind: FailureKind | null | undefined) => (kind ? FAILURE_LABELS[kind] : null);

export function spanFailureKind(span: Span): FailureKind | null {
  if (span.status_code !== "ERROR") return null;
  return failureKind(span.attributes["error.type"], span.attributes["ivy.failure.phase"]);
}

/**
 * Why a failure has no (or only partial) spans from the in-process tracer, for text output.
 * `null` when the tracer reported the invocation itself.
 */
export function missingTraceNote(kind: FailureKind | null, synthetic: boolean): string | null {
  if (kind === "init_failed") return "no trace: the runtime never started the handler (init failed), only the platform report and log tail";
  if (!synthetic) return null;
  if (kind === "timed_out") return "no trace: the handler never finished and the tracer sent nothing; platform report and log tail only";
  return "no trace: the process died before the tracer could report; platform report and log tail only";
}

/** Memory, billed and init figures of an invocation span (after `mergeUpdateSpans`). */
export interface InvocationResources {
  memoryUsedMb: number | null;
  memoryLimitMb: number | null;
  billedDurationMs: number | null;
  initDurationMs: number | null;
  restoreDurationMs: number | null;
}

const num = (v: string | undefined) => {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function invocationResources(span: Span): InvocationResources {
  const a = span.attributes;
  const maxMemory = num(span.resource["faas.max_memory"]);
  return {
    memoryUsedMb: num(a["ivy.memory_max_used_mb"]) ?? num(a["ivy.memory_used_mb"]),
    memoryLimitMb: num(a["ivy.memory_size_mb"]) ?? (maxMemory === null ? null : Math.round(maxMemory / 1048576)),
    billedDurationMs: num(a["ivy.billed_duration_ms"]),
    initDurationMs: num(a["ivy.init_duration_ms"]),
    restoreDurationMs: num(a["ivy.restore_duration_ms"]),
  };
}

export const isUpdateSpan = (span: Span) => span.attributes["ivy.update"] === "true";

/**
 * Applies update spans (`ivy.update = true`: Lambda report data the extension sends after the
 * invocation, keyed by span ID) to the span they update and drops them from the list. Updates
 * whose span is missing are dropped too.
 */
export function mergeUpdateSpans<S extends Span>(spans: S[]): S[] {
  const updates = spans.filter(isUpdateSpan);
  if (!updates.length) return spans;
  const byId = new Map<string, Record<string, string>>();
  for (const u of updates) {
    const { "ivy.update": _marker, ...attributes } = u.attributes;
    byId.set(u.span_id, { ...byId.get(u.span_id), ...attributes });
  }
  return spans
    .filter((s) => !isUpdateSpan(s))
    .map((s) => {
      const extra = byId.get(s.span_id);
      return extra ? { ...s, attributes: { ...s.attributes, ...extra } } : s;
    });
}
