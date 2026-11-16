import { StatusCode, type Attributes, type Span, type SpanEvent } from '../tracer/span.js';
import type { Invocation, Tracer } from '../tracer/tracer.js';
import { capAttributes, toAttrValue } from './attributes.js';
import { SpanStatusCode, type OtelAttributeValue, type OtelAttributes, type SpanContext, type TimeInput } from './api.js';
import { toEvent, toExceptionEvent, type CapSettings } from './span.js';

/** Namespaces of the attributes the layer, the extension and the server set on the invocation span. */
const RESERVED = /^(ivy|faas|cloud|aws|http|url|messaging|error|exception|otel)\./;
const MAX_ATTRIBUTES = 128;
const MAX_EVENTS = 128;

export const isReservedKey = (key: string) => RESERVED.test(key);

/**
 * What `trace.getActiveSpan()` returns inside a handler when no library span is active: it writes custom
 * attributes and events onto the invocation span. The layer owns the invocation's lifecycle, so `end` and
 * `updateName` do nothing, and writes are ignored once the invocation is over (or no longer the active one).
 */
export class InvocationSpan {
  private readonly keys = new Set<string>();
  private readonly events: SpanEvent[] = [];
  private hooked = false;

  constructor(
    readonly invocation: Invocation,
    private readonly tracer: Tracer,
    private readonly caps: CapSettings,
  ) {}

  private get root(): Span | undefined {
    const inv = this.invocation;
    return !inv.done && this.tracer.active === inv ? inv.root : undefined;
  }

  /** User values follow the bridge's payload rules, applied at flush time like for library spans. */
  private hook(root: Span) {
    if (this.hooked) return;
    this.hooked = true;
    const previous = root.finalize;
    root.finalize = (span) => {
      previous?.(span);
      const own = { attributes: {} as Attributes, events: this.events };
      for (const key of this.keys) if (key in span.attributes) own.attributes[key] = span.attributes[key];
      if (capAttributes(own, this.caps.maxBytes, this.caps.isSecret)) span.attributes['ivy.payload.truncated'] = true;
      Object.assign(span.attributes, own.attributes);
    };
  }

  spanContext(): SpanContext {
    const root = this.invocation.root;
    return { traceId: root.traceId, spanId: root.spanId, traceFlags: 1 };
  }

  setAttribute(key: string, value: OtelAttributeValue): this {
    const root = this.root;
    if (!root || isReservedKey(key)) return this;
    if (!this.keys.has(key) && this.keys.size >= MAX_ATTRIBUTES) return this;
    const v = toAttrValue(value);
    if (v === undefined) return this;
    this.hook(root);
    this.keys.add(key);
    root.attributes[key] = v;
    return this;
  }

  setAttributes(attributes: OtelAttributes): this {
    for (const key in attributes) this.setAttribute(key, attributes[key]!);
    return this;
  }

  addEvent(name: string, attributesOrTime?: OtelAttributes | TimeInput, time?: TimeInput): this {
    this.pushEvent(() => toEvent(name, attributesOrTime, time));
    return this;
  }

  recordException(exception: unknown, time?: TimeInput): void {
    this.pushEvent(() => toExceptionEvent(exception, time));
  }

  private pushEvent(create: () => SpanEvent) {
    const root = this.root;
    if (!root || this.events.length >= MAX_EVENTS) return;
    this.hook(root);
    const event = create();
    this.events.push(event);
    root.events.push(event);
  }

  /** ERROR marks the invocation as failed (like an HTTP 5xx response); OK and UNSET are left to the layer. */
  setStatus(status: { code: number; message?: string }): this {
    const root = this.root;
    if (!root || status.code !== SpanStatusCode.ERROR || root.status.code === StatusCode.ERROR) return this;
    root.status = status.message ? { code: StatusCode.ERROR, message: status.message } : { code: StatusCode.ERROR };
    return this;
  }

  addLink(): this {
    return this;
  }

  addLinks(): this {
    return this;
  }

  updateName(): this {
    return this;
  }

  end(): void {}

  isRecording(): boolean {
    return this.root !== undefined;
  }
}
