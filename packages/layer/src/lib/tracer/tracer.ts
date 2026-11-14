import type { Config } from '../config/config.js';
import { chunkSpans } from '../export/chunks.js';
import { encodeSpan, toKeyValues, type OtlpKeyValue, type OtlpSpan } from '../export/otlp.js';
import { detectTrigger, httpStatusFromResult, type Trigger } from '../triggers/detect.js';
import { capString, createKeyMatcher, serialize, serializeBody, type KeyMatcher } from '../utils/redact.js';
import { newTraceId } from '../utils/ids.js';
import { anchorClock, now } from './clock.js';
import { SpanReducer } from './collapse.js';
import { byteLength, isPayloadKey, PayloadBudget } from './payload-budget.js';
import { createSpan, recordError, SpanKind, StatusCode, type Attributes, type Span, type SpanKindValue } from './span.js';

export interface LambdaContext {
  awsRequestId?: string;
  invokedFunctionArn?: string;
  functionName?: string;
  functionVersion?: string;
  memoryLimitInMB?: string;
  getRemainingTimeInMillis?: () => number;
}

export interface SpanBatch {
  requestId: string;
  final: boolean;
  resource: OtlpKeyValue[];
  spans: OtlpSpan[];
}

export interface Invocation {
  requestId: string;
  root: Span;
  children: Span[];
  trigger: Trigger;
  event: unknown;
  logCount: number;
  reducer: SpanReducer;
  done: boolean;
  timer?: NodeJS.Timeout;
}

const MAX_LOG_EVENTS = 500;
const MAX_LOG_BYTES = 4 * 1024;

export class Tracer {
  active: Invocation | undefined;
  readonly isSecret: KeyMatcher;
  private coldStart = true;
  private resource: OtlpKeyValue[] | undefined;
  /** Runs before each invocation (instrumentations that patch lazily check for new modules here). */
  onInvocationStart: (() => void) | undefined;

  constructor(
    readonly config: Config,
    private sink: (batch: SpanBatch) => void,
    private log: (msg: string) => void = () => {},
  ) {
    this.isSecret = createKeyMatcher(config.redactKeys);
  }

  startInvocation(event: unknown, context: LambdaContext): Invocation {
    this.onInvocationStart?.();
    anchorClock();
    const start = now();
    const functionName = context.functionName ?? process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'unknown';
    const trigger = detectTrigger(event);
    const root = createSpan(newTraceId(start), functionName, trigger.kind, start);
    const requestId = context.awsRequestId ?? root.spanId;
    Object.assign(root.attributes, trigger.attributes, {
      'ivy.invocation': true,
      'faas.invocation_id': requestId,
      'faas.coldstart': this.coldStart,
      'faas.trigger': trigger.trigger,
      'ivy.trigger.source': trigger.source,
    } satisfies Attributes);
    if (context.invokedFunctionArn) root.attributes['cloud.resource_id'] = context.invokedFunctionArn;
    root.payloads.push({ key: 'ivy.payload.request', value: event });
    this.coldStart = false;
    if (!this.resource) this.resource = this.buildResource(context);

    const c = this.config;
    const reducer = new SpanReducer(
      { threshold: c.collapseThreshold, keepFirst: c.collapseKeep, keepSlowest: c.collapseKeepSlowest, maxSpans: c.maxSpans },
      root.spanId,
    );
    const inv: Invocation = { requestId, root, children: [], trigger, event, logCount: 0, reducer, done: false };
    this.active = inv;

    const remaining = context.getRemainingTimeInMillis?.();
    if (typeof remaining === 'number' && remaining > this.config.timeoutMarginMs + 50) {
      inv.timer = setTimeout(() => this.onTimeout(inv), remaining - this.config.timeoutMarginMs);
      inv.timer.unref();
    }
    return inv;
  }

  startChild(name: string, kind: SpanKindValue = SpanKind.CLIENT): Span | undefined {
    const inv = this.active;
    if (!inv || inv.done) return undefined;
    if (inv.children.length >= inv.reducer.softLimit) {
      inv.children = inv.reducer.reduce(inv.children, false);
      if (inv.children.length >= inv.reducer.softLimit) {
        inv.reducer.drop(1, 'span limit');
        return undefined;
      }
    }
    const span = createSpan(inv.root.traceId, name, kind, now(), inv.root.spanId);
    inv.children.push(span);
    return span;
  }

  addLog(severity: string, message: string): void {
    const inv = this.active;
    if (!inv || inv.done) return;
    if (inv.logCount++ >= MAX_LOG_EVENTS) return;
    inv.root.events.push({
      name: 'log',
      timeMs: now(),
      attributes: { 'log.severity': severity, 'log.message': capString(message, MAX_LOG_BYTES).text },
    });
  }

  endInvocation(inv: Invocation, err: unknown, result: unknown): void {
    if (inv.done) return;
    inv.done = true;
    if (this.active === inv) this.active = undefined;
    if (inv.timer) clearTimeout(inv.timer);
    this.complete(inv.root, inv, err, result);
    setImmediate(() => this.flush(inv, true));
  }

  private complete(root: Span, inv: Invocation, err: unknown, result: unknown, errorType?: string) {
    const end = now();
    root.endMs = end;
    if (err !== null && err !== undefined) {
      recordError(root, err, end, errorType);
    } else {
      root.payloads.push({ key: 'ivy.payload.response', value: result });
      if (inv.trigger.trigger === 'http') {
        const status = httpStatusFromResult(inv.trigger.source, result);
        if (status !== undefined) {
          root.attributes['http.response.status_code'] = status;
          if (status >= 500) root.status = { code: StatusCode.ERROR, message: `HTTP ${status}` };
        }
      }
    }
    try {
      root.attributes['ivy.memory_used_mb'] = Math.round(process.memoryUsage.rss() / 1048576);
    } catch {
      // best effort
    }
  }

  private onTimeout(inv: Invocation) {
    if (inv.done) return;
    try {
      const root: Span = { ...inv.root, attributes: { ...inv.root.attributes }, events: [...inv.root.events], payloads: [...inv.root.payloads] };
      const err = new Error(`Task timed out (ivy: flushed ${this.config.timeoutMarginMs}ms before the deadline)`);
      err.name = 'Timeout';
      err.stack = undefined;
      this.complete(root, inv, err, undefined, 'Timeout');
      this.flush(inv, false, root);
    } catch (e) {
      this.log(`timeout flush failed: ${(e as Error).message}`);
    }
  }

  /**
   * Collapses repetitive calls, applies the span limit and the payload budget, and hands the spans to
   * the sink: the invocation span alone first, then the children in chunks. Runs after the response.
   */
  flush(inv: Invocation, final: boolean, rootOverride?: Span): void {
    try {
      const root = rootOverride ?? inv.root;
      const end = root.endMs ?? now();
      const reducer = inv.reducer;
      inv.children = reducer.reduce(inv.children, final);
      if (final) reducer.finishSummaries(inv.children);
      const children = inv.children.map((child) => {
        const span = final ? child : { ...child, attributes: { ...child.attributes } };
        if (span.endMs === undefined) {
          span.endMs = end;
          span.attributes['ivy.incomplete'] = true;
        }
        return span;
      });
      if (reducer.collapsedCalls) root.attributes['ivy.collapsed_calls'] = reducer.collapsedCalls;
      if (reducer.dropped) {
        root.attributes['ivy.dropped_spans'] = reducer.dropped;
        root.attributes['ivy.dropped_spans.reason'] = [...reducer.dropReasons].join(', ');
      }
      if (inv.logCount > MAX_LOG_EVENTS) root.attributes['ivy.dropped_logs'] = inv.logCount - MAX_LOG_EVENTS;

      const budget = new PayloadBudget(this.config.maxInvocationPayloadBytes);
      this.applyPayloads(root, budget);
      const encoded = new Map<Span, OtlpSpan>();
      for (const span of payloadOrder(children)) {
        this.applyPayloads(span, budget);
        encoded.set(span, encodeSpan(span));
      }
      if (budget.trimmedPayloads) {
        root.attributes['ivy.trimmed_payload_bytes'] = budget.trimmedBytes;
        root.attributes['ivy.trimmed_payloads'] = budget.trimmedPayloads;
      }

      const resource = this.resource ?? [];
      const chunks = chunkSpans(
        children.map((s) => encoded.get(s)!),
        { spans: this.config.exportChunkSpans, bytes: this.config.exportChunkBytes },
      );
      this.sink({ requestId: inv.requestId, final: final && !chunks.length, resource, spans: [encodeSpan(root)] });
      chunks.forEach((spans, i) => this.sink({ requestId: inv.requestId, final: final && i === chunks.length - 1, resource, spans }));
    } catch (e) {
      this.log(`flush failed: ${(e as Error).message}`);
    }
  }

  /** Runs the span's finalize hook and turns its payloads into attributes while the budget lasts. */
  private applyPayloads(span: Span, budget: PayloadBudget): void {
    try {
      span.finalize?.(span);
    } catch {
      // attribute derivation is best effort
    }
    span.finalize = undefined;
    let trimmed = false;
    for (const key in span.attributes) {
      const v = span.attributes[key];
      if (typeof v === 'string' && isPayloadKey(key) && !budget.take(byteLength(v))) {
        delete span.attributes[key];
        trimmed = true;
      }
    }
    let truncated = false;
    for (const p of span.payloads) {
      if (budget.remaining <= 0) {
        budget.take(typeof p.value === 'string' ? Math.min(byteLength(p.value), this.config.maxPayloadBytes) : 1);
        trimmed = true;
        continue;
      }
      try {
        const capped =
          p.rawContentType !== undefined && typeof p.value === 'string'
            ? serializeBody(p.value, p.rawContentType, this.config.maxPayloadBytes, this.isSecret)
            : serialize(p.value, this.config.maxPayloadBytes, this.isSecret);
        if (!capped.text) continue;
        if (budget.take(byteLength(capped.text))) span.attributes[p.key] = capped.text;
        else trimmed = true;
        truncated ||= capped.truncated;
      } catch {
        // skip unserializable payloads
      }
    }
    span.payloads = [];
    if (truncated) span.attributes['ivy.payload.truncated'] = true;
    if (trimmed) span.attributes['ivy.payload.trimmed'] = true;
  }

  private buildResource(context: LambdaContext): OtlpKeyValue[] {
    const env = process.env;
    const name = context.functionName ?? env.AWS_LAMBDA_FUNCTION_NAME ?? 'unknown';
    const attrs: Attributes = {
      'service.name': name,
      'cloud.provider': 'aws',
      'cloud.platform': 'aws_lambda',
      'faas.name': name,
      'telemetry.sdk.name': 'ivy-layer',
      'telemetry.sdk.language': 'nodejs',
      'process.runtime.version': process.versions.node,
    };
    const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    if (region) attrs['cloud.region'] = region;
    const account = context.invokedFunctionArn?.split(':')[4];
    if (account) attrs['cloud.account.id'] = account;
    const version = context.functionVersion ?? env.AWS_LAMBDA_FUNCTION_VERSION;
    if (version) attrs['faas.version'] = version;
    const memory = parseInt(context.memoryLimitInMB ?? env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? '', 10);
    if (Number.isFinite(memory)) attrs['faas.max_memory'] = memory * 1024 * 1024;
    if (env.AWS_LAMBDA_LOG_STREAM_NAME) attrs['faas.instance'] = env.AWS_LAMBDA_LOG_STREAM_NAME;
    return toKeyValues(attrs);
  }
}

/**
 * The order spans get the payload budget in: failing spans first, then the slowest tenth (at least
 * five), then the rest by start time.
 */
export function payloadOrder(spans: Span[]): Span[] {
  const isError = (s: Span) => s.status.code === StatusCode.ERROR;
  const errors = spans.filter(isError);
  const rest = spans.filter((s) => !isError(s));
  const dur = (s: Span) => (s.endMs ?? s.startMs) - s.startMs;
  const slowCount = Math.max(5, Math.ceil(rest.length / 10));
  const slowest = new Set([...rest].sort((a, b) => dur(b) - dur(a)).slice(0, slowCount));
  return [...errors, ...rest.filter((s) => slowest.has(s)), ...rest.filter((s) => !slowest.has(s)).sort((a, b) => a.startMs - b.startMs)];
}
