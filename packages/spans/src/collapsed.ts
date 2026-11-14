import type { Span } from "./types.js";

/**
 * A summary span: a run of similar calls (same signature) that the tracer folded into one span
 * (docs/implementation/span-conventions.md). The first and slowest calls, and every failing one,
 * are kept as ordinary spans next to it.
 */
export interface CollapsedInfo {
  /** Calls represented by the summary (not counting the ones kept in full). */
  count: number;
  totalMs: number;
  maxMs: number;
  minMs: number;
  avgMs: number;
  /** Failing calls with this signature; each is kept in full as its own span. */
  errors: number;
  /** Calls with this signature kept in full as their own spans. */
  kept: number;
  signature?: string;
}

export interface DroppedSpans {
  count: number;
  reason?: string;
}

const COUNT_SUFFIX = / × [\d,.  ]+$/;

const int = (v: string | undefined) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : 0;
};

/** Thousands separators, e.g. `1,184`. */
export const formatCount = (n: number) => n.toLocaleString("en-US");

export function collapsedInfo(span: Span): CollapsedInfo | undefined {
  const a = span.attributes;
  const count = int(a["ivy.collapsed.count"]);
  if (count <= 0) return undefined;
  const totalMs = int(a["ivy.collapsed.duration_total_ms"]);
  return {
    count,
    totalMs,
    maxMs: int(a["ivy.collapsed.duration_max_ms"]),
    minMs: int(a["ivy.collapsed.duration_min_ms"]),
    avgMs: totalMs / count,
    errors: int(a["ivy.collapsed.errors"]),
    kept: int(a["ivy.collapsed.kept"]),
    signature: a["ivy.collapsed.signature"] || undefined,
  };
}

/** The span name without the summary's ` × 1,184` suffix. */
export const collapsedBaseName = (name: string) => name.replace(COUNT_SUFFIX, "");

/** Spans of an invocation that were omitted (span limit, or lost in export), from its root's attributes. */
export function droppedSpans(attributes: Record<string, string>): DroppedSpans | undefined {
  const count = int(attributes["ivy.dropped_spans"]);
  if (count <= 0) return undefined;
  return { count, reason: attributes["ivy.dropped_spans.reason"] || undefined };
}

/** E.g. `37 spans omitted (span limit)`. */
export function droppedSpansLabel(dropped: DroppedSpans): string {
  const spans = `${formatCount(dropped.count)} span${dropped.count === 1 ? "" : "s"} omitted`;
  return dropped.reason ? `${spans} (${dropped.reason})` : spans;
}

/** Total calls folded into summary spans in an invocation, from its root's attributes. */
export const collapsedCalls = (attributes: Record<string, string>) => int(attributes["ivy.collapsed_calls"]) || undefined;
