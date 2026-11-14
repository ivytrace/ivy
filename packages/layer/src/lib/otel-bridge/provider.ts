import type { Span, SpanKindValue } from '../tracer/span.js';
import type { Tracer as IvyTracer } from '../tracer/tracer.js';
import { setAttributes } from './attributes.js';
import { SPAN_KEY, type Context, type SpanOptions } from './api.js';
import { activeContext, AlsContextManager, globalContextManager } from './context.js';
import { BridgeSpan, NonRecordingSpan, toEpochMs, type CapSettings } from './span.js';

type StartChild = (name: string, kind?: SpanKindValue) => Span | undefined;
type ActiveFn = (span: BridgeSpan | NonRecordingSpan) => unknown;

/** OTel span kinds are 0-based (INTERNAL = 0), OTLP's are 1-based. */
const toIvyKind = (kind: number | undefined) => (((kind ?? 0) + 1) as SpanKindValue);

export class BridgeTracer {
  constructor(
    private readonly ivy: IvyTracer,
    private readonly startChild: StartChild,
    private readonly caps: CapSettings,
    private readonly scope: string,
    private readonly fallbackContext: AlsContextManager,
  ) {}

  startSpan(name: string, options: SpanOptions = {}, context: Context = activeContext()): BridgeSpan | NonRecordingSpan {
    const inv = this.ivy.active;
    if (!inv || inv.done) return new NonRecordingSpan();
    const parent = options.root ? undefined : context?.getValue?.(SPAN_KEY);
    const span = this.startChild(name, toIvyKind(options.kind));
    if (!span) return new NonRecordingSpan();
    // A parent from this bridge and this invocation keeps the hierarchy; anything else hangs off the invocation.
    if (parent instanceof BridgeSpan && parent.invocation === inv) span.parentSpanId = parent.ivy.spanId;
    const start = toEpochMs(options.startTime);
    if (start !== undefined) span.startMs = start;
    span.attributes['otel.scope.name'] = this.scope;
    setAttributes(span.attributes, options.attributes);
    return new BridgeSpan(span, inv, this.caps);
  }

  startActiveSpan(name: string, ...rest: unknown[]): unknown {
    const fn = rest.pop() as ActiveFn;
    const [options, context] = rest as [SpanOptions | undefined, Context | undefined];
    const parentContext = context ?? activeContext();
    const span = this.startSpan(name, options, parentContext);
    const manager = globalContextManager() ?? this.fallbackContext;
    return manager.with(parentContext.setValue(SPAN_KEY, span), fn, undefined, span);
  }
}

export class BridgeTracerProvider {
  private readonly tracers = new Map<string, BridgeTracer>();

  constructor(
    private readonly ivy: IvyTracer,
    private readonly startChild: StartChild,
    private readonly caps: CapSettings,
    private readonly fallbackContext: AlsContextManager,
  ) {}

  getTracer(name = 'unknown'): BridgeTracer {
    let tracer = this.tracers.get(name);
    if (!tracer) {
      tracer = new BridgeTracer(this.ivy, this.startChild, this.caps, name, this.fallbackContext);
      this.tracers.set(name, tracer);
    }
    return tracer;
  }
}
