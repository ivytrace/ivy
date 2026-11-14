import { bodyTokens, isLlmCall, REPRESENTATIVE_ATTRIBUTES, signatureOf, spanTokens } from './signature.js';
import { createSpan, StatusCode, type Span } from './span.js';

export interface CollapseOptions {
  /** Collapse a signature once more than this many calls share it (0 turns collapsing off). */
  threshold: number;
  /** Calls kept in full from the start of a run. */
  keepFirst: number;
  /** Slowest calls of a run kept in full. */
  keepSlowest: number;
  /** Child spans kept per invocation after collapsing. */
  maxSpans: number;
}

interface Group {
  signature: string;
  baseName: string;
  /** Calls seen with this signature under this parent, collapsed or not. */
  calls: number;
  firstKept: number;
  summary?: Span;
  count: number;
  totalMs: number;
  maxMs: number;
  minMs: number;
  start: number;
  end: number;
  inputTokens: number;
  outputTokens: number;
  removedSpans: number;
}

/** Collapse and span-limit bookkeeping for one invocation. */
export class SpanReducer {
  private groups = new Map<string, Group>();
  private counted = new WeakSet<Span>();
  private keptFirst = new WeakSet<Span>();
  private summaries = new WeakSet<Span>();
  collapsedCalls = 0;
  dropped = 0;
  readonly dropReasons = new Set<string>();

  constructor(
    private opts: CollapseOptions,
    private rootSpanId: string,
  ) {}

  isSummary(span: Span): boolean {
    return this.summaries.has(span);
  }

  /** Buffer size at which spans are reduced while the invocation runs. */
  get softLimit(): number {
    return this.opts.maxSpans + Math.max(100, Math.floor(this.opts.maxSpans / 4));
  }

  drop(n: number, reason: string): void {
    this.dropped += n;
    this.dropReasons.add(reason);
  }

  /** Collapses runs of similar finished calls and enforces the span limit. Returns the spans to keep. */
  reduce(children: Span[], final: boolean): Span[] {
    let spans = this.opts.threshold > 0 ? this.collapse(children, final) : children;
    if (spans.length > this.opts.maxSpans) spans = this.limit(spans, final);
    return spans;
  }

  private collapse(children: Span[], final: boolean): Span[] {
    const kids = childrenIndex(children);
    const settledMemo = new Map<Span, boolean>();
    const settled = (s: Span): boolean => {
      let v = settledMemo.get(s);
      if (v === undefined) {
        v = (final || s.endMs !== undefined) && s.status.code !== StatusCode.ERROR && (kids.get(s.spanId) ?? []).every(settled);
        settledMemo.set(s, v);
      }
      return v;
    };

    const candidates = new Map<string, Span[]>();
    for (const s of children) {
      if (this.summaries.has(s)) continue;
      const parent = s.parentSpanId ?? this.rootSpanId;
      const key = `${parent}\u0000${signatureOf(s)}`;
      const isError = s.status.code === StatusCode.ERROR;
      if (!this.counted.has(s) && (isError || s.endMs !== undefined || final)) {
        this.counted.add(s);
        const g = this.group(key, s);
        g.calls++;
      }
      if (!isError && !this.keptFirst.has(s) && settled(s)) {
        const list = candidates.get(key);
        if (list) list.push(s);
        else candidates.set(key, [s]);
      }
    }

    const removed = new Set<Span>();
    const added: Span[] = [];
    for (const [key, list] of candidates) {
      const g = this.groups.get(key)!;
      if (g.calls <= this.opts.threshold) continue;
      list.sort((a, b) => a.startMs - b.startMs);
      const take = Math.min(list.length, Math.max(0, this.opts.keepFirst - g.firstKept));
      for (const s of list.splice(0, take)) this.keptFirst.add(s);
      g.firstKept += take;
      list.sort((a, b) => duration(b) - duration(a));
      const folded = list.slice(this.opts.keepSlowest);
      if (!folded.length) continue;
      for (const s of folded) this.fold(g, s, kids, removed);
      if (!g.summary) {
        g.summary = this.summarySpan(folded[0], g);
        this.summaries.add(g.summary);
        added.push(g.summary);
      }
      this.updateSummary(g);
    }
    if (!removed.size && !added.length) return children;
    return [...children.filter((s) => !removed.has(s)), ...added];
  }

  private group(key: string, s: Span): Group {
    let g = this.groups.get(key);
    if (!g) {
      g = {
        signature: signatureOf(s),
        baseName: s.name,
        calls: 0,
        firstKept: 0,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        minMs: Infinity,
        start: Infinity,
        end: -Infinity,
        inputTokens: 0,
        outputTokens: 0,
        removedSpans: 0,
      };
      this.groups.set(key, g);
    }
    return g;
  }

  private fold(g: Group, s: Span, kids: Map<string, Span[]>, removed: Set<Span>): void {
    const d = duration(s);
    g.count++;
    g.totalMs += d;
    g.maxMs = Math.max(g.maxMs, d);
    g.minMs = Math.min(g.minMs, d);
    g.start = Math.min(g.start, s.startMs);
    g.end = Math.max(g.end, s.endMs ?? s.startMs);
    const tokens = this.tokensOf(s);
    g.inputTokens += tokens.input ?? 0;
    g.outputTokens += tokens.output ?? 0;
    this.collapsedCalls++;
    const stack = [s];
    while (stack.length) {
      const x = stack.pop()!;
      removed.add(x);
      g.removedSpans++;
      stack.push(...(kids.get(x.spanId) ?? []));
    }
  }

  private tokensOf(s: Span): { input?: number; output?: number } {
    const t = spanTokens(s.attributes);
    if (t.input !== undefined || t.output !== undefined) return t;
    if (!isLlmCall(s.attributes['server.address'] as string | undefined, s.attributes['url.full'] as string | undefined)) return t;
    try {
      s.finalize?.(s);
      s.finalize = undefined;
      const body = s.payloads.find((p) => p.key === 'ivy.payload.response')?.value;
      return typeof body === 'string' ? bodyTokens(body) : t;
    } catch {
      return t;
    }
  }

  private summarySpan(first: Span, g: Group): Span {
    const span = createSpan(first.traceId, g.baseName, first.kind, g.start, first.parentSpanId ?? this.rootSpanId);
    for (const k of REPRESENTATIVE_ATTRIBUTES) if (first.attributes[k] !== undefined) span.attributes[k] = first.attributes[k];
    return span;
  }

  private updateSummary(g: Group): void {
    const s = g.summary!;
    s.name = `${g.baseName} × ${g.count.toLocaleString('en-US')}`;
    s.startMs = g.start;
    s.endMs = g.end;
    Object.assign(s.attributes, {
      'ivy.collapsed.count': g.count,
      'ivy.collapsed.duration_total_ms': round(g.totalMs),
      'ivy.collapsed.duration_max_ms': round(g.maxMs),
      'ivy.collapsed.duration_min_ms': round(g.minMs),
      'ivy.collapsed.kept': g.calls - g.count,
      'ivy.collapsed.signature': g.signature,
    });
    if (g.inputTokens || g.outputTokens) {
      s.attributes['ivy.collapsed.input_tokens'] = g.inputTokens;
      s.attributes['ivy.collapsed.output_tokens'] = g.outputTokens;
    }
    if (g.removedSpans > g.count) s.attributes['ivy.collapsed.spans'] = g.removedSpans;
  }

  /** Error counts per summary, taken at flush when every call has finished. */
  finishSummaries(children: Span[]): void {
    const errors = new Map<string, number>();
    for (const s of children) {
      if (s.status.code !== StatusCode.ERROR) continue;
      const key = `${s.parentSpanId ?? this.rootSpanId}\u0000${signatureOf(s)}`;
      errors.set(key, (errors.get(key) ?? 0) + 1);
    }
    for (const [key, g] of this.groups) if (g.summary) g.summary.attributes['ivy.collapsed.errors'] = errors.get(key) ?? 0;
  }

  /**
   * Keeps at most `maxSpans`: errors, summaries and unfinished spans (plus their ancestors) first,
   * then the shallowest spans (the root's direct children before their own children), slowest first.
   */
  private limit(children: Span[], final: boolean): Span[] {
    const byId = new Map(children.map((s) => [s.spanId, s]));
    const depthMemo = new Map<Span, number>();
    const depth = (s: Span): number => {
      let d = depthMemo.get(s);
      if (d === undefined) {
        const p = s.parentSpanId && s.parentSpanId !== this.rootSpanId ? byId.get(s.parentSpanId) : undefined;
        depthMemo.set(s, 0);
        d = p ? depth(p) + 1 : 0;
        depthMemo.set(s, d);
      }
      return d;
    };
    const keep = new Set<Span>();
    const keepWithAncestors = (s: Span) => {
      for (let x: Span | undefined = s; x && !keep.has(x); x = x.parentSpanId ? byId.get(x.parentSpanId) : undefined) keep.add(x);
    };
    for (const s of children) {
      if (s.status.code === StatusCode.ERROR || this.summaries.has(s) || (!final && s.endMs === undefined)) keepWithAncestors(s);
    }
    const rest = children.filter((s) => !keep.has(s)).sort((a, b) => depth(a) - depth(b) || duration(b) - duration(a));
    for (const s of rest) {
      if (keep.size >= this.opts.maxSpans) break;
      if (!s.parentSpanId || s.parentSpanId === this.rootSpanId || keep.has(byId.get(s.parentSpanId)!)) keep.add(s);
    }
    const out = children.filter((s) => keep.has(s));
    if (out.length < children.length) this.drop(children.length - out.length, 'span limit');
    return out;
  }
}

function childrenIndex(spans: Span[]): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  for (const s of spans) {
    if (!s.parentSpanId) continue;
    const list = out.get(s.parentSpanId);
    if (list) list.push(s);
    else out.set(s.parentSpanId, [s]);
  }
  return out;
}

const duration = (s: Span) => (s.endMs ?? s.startMs) - s.startMs;
const round = (ms: number) => Math.round(ms * 1000) / 1000;
