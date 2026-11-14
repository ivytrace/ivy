import { isInvocationSpan, type Span, type SpanEvent } from "@ivy/spans";

export interface TraceNode {
  span: Span;
  children: TraceNode[];
}

export const startMs = (span: Span) => Date.parse(span.start);
export const endMs = (span: Span) => Math.max(Date.parse(span.end), startMs(span) + span.duration_ms);

const byStart = (a: TraceNode, b: TraceNode) => startMs(a.span) - startMs(b.span) || a.span.span_id.localeCompare(b.span.span_id);

/** Builds the span tree; spans whose parent is missing become roots. Children are sorted by start time. */
export function buildTree(spans: Span[]): TraceNode[] {
  const nodes = new Map(spans.map((span) => [span.span_id, { span, children: [] as TraceNode[] }]));
  const roots: TraceNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parent_span_id ? nodes.get(node.span.parent_span_id) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) node.children.sort(byStart);
  return roots.sort(byStart);
}

/** Pre-order list of spans, in tree order. */
export function flatten(nodes: TraceNode[], depth = 0): { span: Span; depth: number }[] {
  return nodes.flatMap((node) => [{ span: node.span, depth }, ...flatten(node.children, depth + 1)]);
}

/** The outermost invocation span of the trace (the one whose parent is not in the trace). */
export function rootInvocation(spans: Span[]): Span | undefined {
  const ids = new Set(spans.map((s) => s.span_id));
  const invocations = spans.filter(isInvocationSpan);
  return invocations.find((s) => !s.parent_span_id || !ids.has(s.parent_span_id)) ?? invocations[0];
}

export function traceBounds(spans: Span[]): { start: number; end: number } {
  return {
    start: Math.min(...spans.map(startMs)),
    end: Math.max(...spans.map(endMs)),
  };
}

export const logEvents = (span: Span): SpanEvent[] => span.events.filter((e) => e.name === "log");
