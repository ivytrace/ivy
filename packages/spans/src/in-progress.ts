import type { Span } from "./types.js";

/**
 * Long-running invocations: while an invocation runs past `IVY_INPROGRESS_AFTER_MS` the extension exports
 * a provisional invocation span (`ivy.in_progress = true`) with the IDs the final one will have
 * (docs/implementation/span-conventions.md). The final span supersedes it.
 */

/** After the deadline, how long the final span still has to arrive before the invocation counts as "no completion recorded". */
export const COMPLETION_GRACE_MS = 15_000;

export type InProgressState = "running" | "no_completion";

export const isInProgressSpan = (span: Span) => span.attributes["ivy.in_progress"] === "true";

/** `running` until the deadline (plus a grace for the final span to be exported), then `no_completion`. */
export function inProgressState(deadlineMs: number | null | undefined, nowMs: number = Date.now()): InProgressState {
  if (deadlineMs === null || deadlineMs === undefined || !Number.isFinite(deadlineMs)) return "running";
  return nowMs > deadlineMs + COMPLETION_GRACE_MS ? "no_completion" : "running";
}

/** Deadline (unix ms) of a provisional invocation span, if it has one. */
export function spanDeadlineMs(span: Span): number | null {
  const v = Number(span.attributes["ivy.deadline_ms"]);
  return span.attributes["ivy.deadline_ms"] && Number.isFinite(v) ? v : null;
}

/**
 * Keeps one record per span ID: a final span supersedes provisional (`ivy.in_progress`) ones with the same ID,
 * and of several provisional records (the extension refreshes them) the one seen last wins. Lists without
 * provisional spans are returned unchanged.
 */
export function mergeInProgressSpans<S extends Span>(spans: S[]): S[] {
  if (!spans.some(isInProgressSpan)) return spans;
  const finals = new Set(spans.filter((s) => !isInProgressSpan(s)).map((s) => s.span_id));
  const latest = new Map<string, S>();
  for (const s of spans) {
    if (!isInProgressSpan(s) || finals.has(s.span_id)) continue;
    const prev = latest.get(s.span_id);
    if (!prev || Date.parse(s.end) >= Date.parse(prev.end)) latest.set(s.span_id, s);
  }
  return spans.filter((s) => !isInProgressSpan(s) || latest.get(s.span_id) === s);
}

/** `850ms`, `14s`, `2m 14s`, `1h 3m`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "running for 2m 14s (in progress)" or "no completion recorded". */
export function inProgressText(startMs: number, deadlineMs: number | null, nowMs: number = Date.now()): string {
  if (inProgressState(deadlineMs, nowMs) === "no_completion") return "no completion recorded";
  return `running for ${formatElapsed(nowMs - startMs)} (in progress)`;
}

export const NO_COMPLETION_EXPLANATION =
  "The invocation passed its deadline without a final record. The execution environment probably stopped before Ivy could report the outcome (for example it was shut down or ran out of memory along with the extension).";
