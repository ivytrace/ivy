import type { Span, SpanKindValue } from '../tracer/span.js';
import type { Tracer } from '../tracer/tracer.js';
import { SPAN_KEY } from './api.js';
import { activeContext, AlsContextManager } from './context.js';
import { BridgeTracerProvider } from './provider.js';
import { apiVersion, hasOwnSdk, registerGlobal } from './register.js';
import { BridgeSpan } from './span.js';

const off = (v: string | undefined) => !!v && ['0', 'false', 'no', 'off'].includes(v.toLowerCase());

/**
 * Turns OpenTelemetry spans from libraries (Vercel AI SDK, OpenAI/Anthropic/LangChain instrumentations, …)
 * into Ivy spans of the current invocation. See docs/implementation/llm-spans.md.
 *
 * Registers a global tracer provider before the user handler loads, so tracers that libraries cache at
 * import time are already the bridge's. If the app ships an OpenTelemetry SDK it most likely registers its
 * own provider while loading; the bridge then waits for the first invocation and only registers if the slot
 * is still free. `IVY_CAPTURE_OTEL=false` turns it off.
 */
export function installOtelBridge(tracer: Tracer, env: NodeJS.ProcessEnv = process.env): void {
  if (off(env.IVY_CAPTURE_OTEL)) return;
  try {
    const appRoot = env.LAMBDA_TASK_ROOT ?? process.cwd();
    const startChild: (name: string, kind?: SpanKindValue) => Span | undefined = tracer.startChild.bind(tracer);
    const contextManager = new AlsContextManager();
    const caps = { maxBytes: tracer.config.maxPayloadBytes, isSecret: tracer.isSecret };
    const provider = new BridgeTracerProvider(tracer, startChild, caps, contextManager);

    const register = () => {
      if (!registerGlobal(provider, contextManager, apiVersion(appRoot))) return;
      // Spans of the layer's own instrumentation (fetch, http, AWS SDK) nest under the active OTel span,
      // e.g. the provider's HTTP call under the AI SDK's model-call span.
      tracer.startChild = (name, kind) => {
        const span = startChild(name, kind);
        if (span) {
          const parent = activeContext().getValue(SPAN_KEY);
          if (parent instanceof BridgeSpan && parent.invocation === tracer.active) span.parentSpanId = parent.ivy.spanId;
        }
        return span;
      };
    };

    if (!hasOwnSdk(appRoot)) {
      register();
      return;
    }
    const startInvocation = tracer.startInvocation;
    tracer.startInvocation = (...args) => {
      tracer.startInvocation = startInvocation;
      try {
        register();
      } catch {
        // best effort
      }
      return startInvocation.apply(tracer, args);
    };
  } catch {
    // capture of library spans is best effort and must never break the handler
  }
}
