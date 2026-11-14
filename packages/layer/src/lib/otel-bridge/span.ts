import { performance } from 'node:perf_hooks';
import { now } from '../tracer/clock.js';
import { cleanStack, StatusCode, type Attributes, type Span } from '../tracer/span.js';
import type { Invocation } from '../tracer/tracer.js';
import type { KeyMatcher } from '../utils/redact.js';
import { capAttributes, setAttributes, toAttrValue } from './attributes.js';
import { SpanStatusCode, type OtelAttributeValue, type OtelAttributes, type SpanContext, type TimeInput } from './api.js';

/** OTel `TimeInput` → epoch milliseconds. Numbers below the time origin are `performance.now()` values. */
export function toEpochMs(time: TimeInput | undefined): number | undefined {
  if (time === undefined || time === null) return undefined;
  if (Array.isArray(time)) return time[0] * 1000 + time[1] / 1e6;
  if (time instanceof Date) return time.getTime();
  if (typeof time === 'number') return time < performance.timeOrigin ? performance.timeOrigin + time : time;
  return undefined;
}

export interface CapSettings {
  maxBytes: number;
  isSecret: KeyMatcher;
}

/** An OTel span that writes into an Ivy span of the current invocation. */
export class BridgeSpan {
  private ended = false;

  constructor(
    readonly ivy: Span,
    readonly invocation: Invocation,
    caps: CapSettings,
  ) {
    ivy.finalize = (span) => {
      if (capAttributes(span, caps.maxBytes, caps.isSecret)) span.attributes['ivy.payload.truncated'] = true;
    };
  }

  spanContext(): SpanContext {
    return { traceId: this.ivy.traceId, spanId: this.ivy.spanId, traceFlags: 1 };
  }

  setAttribute(key: string, value: OtelAttributeValue): this {
    if (!this.ended) {
      const v = toAttrValue(value);
      if (v !== undefined) this.ivy.attributes[key] = v;
    }
    return this;
  }

  setAttributes(attributes: OtelAttributes): this {
    if (!this.ended) setAttributes(this.ivy.attributes, attributes);
    return this;
  }

  addEvent(name: string, attributesOrTime?: OtelAttributes | TimeInput, time?: TimeInput): this {
    if (this.ended) return this;
    let attributes: OtelAttributes | undefined;
    if (attributesOrTime instanceof Date || Array.isArray(attributesOrTime) || typeof attributesOrTime === 'number') {
      time = attributesOrTime;
    } else {
      attributes = attributesOrTime;
    }
    const attrs: Attributes = {};
    setAttributes(attrs, attributes);
    this.ivy.events.push({ name, timeMs: toEpochMs(time) ?? now(), attributes: attrs });
    return this;
  }

  addLink(): this {
    return this;
  }

  addLinks(): this {
    return this;
  }

  setStatus(status: { code: number; message?: string }): this {
    if (this.ended) return this;
    // OK is final; ERROR replaces UNSET (OTel semantics).
    if (this.ivy.status.code === SpanStatusCode.OK) return this;
    if (status.code === SpanStatusCode.UNSET) return this;
    this.ivy.status = status.message ? { code: status.code, message: status.message } : { code: status.code };
    return this;
  }

  updateName(name: string): this {
    if (!this.ended) this.ivy.name = name;
    return this;
  }

  recordException(exception: unknown, time?: TimeInput): void {
    if (this.ended) return;
    const e = exception as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown } | string | null;
    const attributes: Attributes = {};
    if (typeof e === 'string') {
      attributes['exception.message'] = e;
    } else if (e && typeof e === 'object') {
      const type = e.name ?? e.code;
      if (type !== undefined) attributes['exception.type'] = String(type);
      if (e.message !== undefined) attributes['exception.message'] = String(e.message);
      const stack = typeof e.stack === 'string' ? cleanStack(e.stack) : undefined;
      if (stack) attributes['exception.stacktrace'] = stack;
    }
    this.ivy.events.push({ name: 'exception', timeMs: toEpochMs(time) ?? now(), attributes });
  }

  end(endTime?: TimeInput): void {
    if (this.ended) return;
    this.ended = true;
    this.ivy.endMs = Math.max(toEpochMs(endTime) ?? now(), this.ivy.startMs);
    if (this.ivy.status.code === StatusCode.ERROR && this.ivy.attributes['error.type'] === undefined) {
      const ex = this.ivy.events.find((e) => e.name === 'exception');
      this.ivy.attributes['error.type'] = String(ex?.attributes['exception.type'] ?? 'Error');
    }
  }

  isRecording(): boolean {
    return !this.ended;
  }
}

const INVALID_SPAN_CONTEXT: SpanContext = { traceId: '00000000000000000000000000000000', spanId: '0000000000000000', traceFlags: 0 };

/** Returned for spans started outside an invocation (e.g. during init) or over the span limit. */
export class NonRecordingSpan {
  constructor(private readonly context: SpanContext = INVALID_SPAN_CONTEXT) {}
  spanContext(): SpanContext {
    return this.context;
  }
  setAttribute(): this {
    return this;
  }
  setAttributes(): this {
    return this;
  }
  addEvent(): this {
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }
  setStatus(): this {
    return this;
  }
  updateName(): this {
    return this;
  }
  recordException(): void {}
  end(): void {}
  isRecording(): boolean {
    return false;
  }
}
