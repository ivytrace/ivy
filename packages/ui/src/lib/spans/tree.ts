import { isInvocationSpan } from "./services";
import type { Span } from "./types";

export interface WaterfallRow {
  span: Span;
  depth: number;
  offsetPct: number;
  widthPct: number;
  invocationId?: string;
}

export interface Waterfall {
  rows: WaterfallRow[];
  startMs: number;
  totalMs: number;
}

const ms = (iso: string) => new Date(iso).getTime();

export function buildWaterfall(spans: Span[]): Waterfall {
  if (!spans.length) return { rows: [], startMs: 0, totalMs: 0 };

  const ids = new Set(spans.map((s) => s.span_id));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const span of spans) {
    if (span.parent_span_id && ids.has(span.parent_span_id)) {
      const list = children.get(span.parent_span_id) ?? [];
      list.push(span);
      children.set(span.parent_span_id, list);
    } else {
      roots.push(span);
    }
  }

  const byStart = (a: Span, b: Span) => a.start.localeCompare(b.start);
  const startMs = Math.min(...spans.map((s) => ms(s.start)));
  const endMs = Math.max(...spans.map((s) => Math.max(ms(s.end), ms(s.start) + s.duration_ms)));
  const totalMs = Math.max(endMs - startMs, 1);

  const rows: WaterfallRow[] = [];
  const visit = (span: Span, depth: number, invocationId: string | undefined) => {
    const owner = isInvocationSpan(span) ? span.span_id : invocationId;
    const offset = ms(span.start) - startMs;
    rows.push({
      span,
      depth,
      invocationId: owner,
      offsetPct: (offset / totalMs) * 100,
      widthPct: Math.max((span.duration_ms / totalMs) * 100, 0.3),
    });
    for (const child of (children.get(span.span_id) ?? []).sort(byStart)) {
      visit(child, depth + 1, owner);
    }
  };
  for (const root of roots.sort(byStart)) visit(root, 0, undefined);

  return { rows, startMs, totalMs };
}

export function filterInvocation(rows: WaterfallRow[], invocationId: string): WaterfallRow[] {
  const filtered = rows.filter((r) => r.invocationId === invocationId);
  if (!filtered.length) return rows;
  const minDepth = Math.min(...filtered.map((r) => r.depth));
  return filtered.map((r) => ({ ...r, depth: r.depth - minDepth }));
}

export function findRootInvocation(spans: Span[]): Span | undefined {
  const invocations = spans.filter(isInvocationSpan);
  const ids = new Set(spans.map((s) => s.span_id));
  return invocations.find((s) => !s.parent_span_id || !ids.has(s.parent_span_id)) ?? invocations[0];
}
