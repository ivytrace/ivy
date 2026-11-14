import type { GeneratedInvocation } from '../trace/generate.js';
import type { AttrValue, Attributes, FunctionResource, SpanKind } from '../trace/invocation.js';

const KIND: Record<SpanKind, number> = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 };
const STATUS = { OK: 1, ERROR: 2 } as const;

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } };

function anyValue(value: AttrValue): AnyValue {
  if (Array.isArray(value)) return { arrayValue: { values: value.map((v) => ({ stringValue: v })) } };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: value };
}

export function attributes(attrs: Attributes) {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: anyValue(value) }));
}

export function unixNano(ms: number): string {
  const whole = Math.floor(ms);
  const fraction = Math.round((ms - whole) * 1e6);
  return (BigInt(whole) * 1_000_000n + BigInt(fraction)).toString();
}

export function resourceAttributes(fn: FunctionResource): Attributes {
  return {
    'service.name': fn.name,
    'cloud.provider': 'aws',
    'cloud.platform': 'aws_lambda',
    'cloud.region': fn.region,
    'cloud.account.id': fn.accountId,
    'faas.name': fn.name,
    'faas.version': '$LATEST',
    'faas.max_memory': fn.memoryMb * 1024 * 1024,
    'telemetry.sdk.name': 'ivy-layer',
    'telemetry.sdk.language': 'nodejs',
  };
}

/** Encodes invocations as an OTLP/HTTP JSON ExportTraceServiceRequest, one ResourceSpans per function. */
export function encodeTraces(invocations: GeneratedInvocation[]) {
  const byFunction = new Map<string, GeneratedInvocation[]>();
  for (const inv of invocations) {
    const list = byFunction.get(inv.resource.name) ?? [];
    list.push(inv);
    byFunction.set(inv.resource.name, list);
  }
  return {
    resourceSpans: [...byFunction.values()].map((list) => ({
      resource: { attributes: attributes(resourceAttributes(list[0].resource)) },
      scopeSpans: [
        {
          scope: { name: '@ivy/layer', version: '0.1.0' },
          spans: list.flatMap((inv) =>
            inv.spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId || undefined,
              name: span.name,
              kind: KIND[span.kind],
              startTimeUnixNano: unixNano(span.startMs),
              endTimeUnixNano: unixNano(span.endMs),
              attributes: attributes(span.attributes),
              events: span.events.map((event) => ({
                timeUnixNano: unixNano(event.timeMs),
                name: event.name,
                attributes: attributes(event.attributes),
              })),
              status: span.status ? { code: STATUS[span.status.code], message: span.status.message } : undefined,
            })),
          ),
        },
      ],
    })),
  };
}
