import { newSpanId } from '../utils/ids.js';

export type AttrValue = string | number | boolean | string[];
export type Attributes = Record<string, AttrValue>;

export const SpanKind = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 } as const;
export type SpanKindValue = (typeof SpanKind)[keyof typeof SpanKind];

export const StatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;

export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes: Attributes;
}

/** A value serialized lazily (after the response is sent) into an `ivy.payload.*` attribute. */
export interface PendingPayload {
  key: string;
  value: unknown;
  /** Raw body text with this content type, instead of a JS value. */
  rawContentType?: string;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKindValue;
  startMs: number;
  endMs?: number;
  attributes: Attributes;
  events: SpanEvent[];
  status: { code: number; message?: string };
  payloads: PendingPayload[];
  /** Hook run at flush time to derive attributes from payloads etc. */
  finalize?: (span: Span) => void;
}

export function createSpan(traceId: string, name: string, kind: SpanKindValue, startMs: number, parentSpanId?: string): Span {
  return {
    traceId,
    spanId: newSpanId(),
    parentSpanId,
    name,
    kind,
    startMs,
    attributes: {},
    events: [],
    status: { code: StatusCode.UNSET },
    payloads: [],
  };
}

export function cleanStack(stack: string | undefined): string | undefined {
  if (!stack) return stack;
  return stack
    .split('\n')
    .filter((line) => !line.includes('/opt/nodejs/ivy/'))
    .join('\n');
}

export function recordError(span: Span, err: unknown, timeMs: number, errorType?: string): void {
  const e = err as { name?: unknown; message?: unknown; stack?: unknown; constructor?: { name?: string } } | null;
  const type =
    errorType ??
    (e && typeof e === 'object'
      ? String(e.name ?? e.constructor?.name ?? 'Error')
      : typeof err === 'string'
        ? 'Error'
        : typeof err);
  const message = e && typeof e === 'object' ? String(e.message ?? '') : String(err);
  span.status = { code: StatusCode.ERROR, message };
  span.attributes['error.type'] = type;
  const attributes: Attributes = { 'exception.type': type, 'exception.message': message };
  const stack = e && typeof e === 'object' && typeof e.stack === 'string' ? cleanStack(e.stack) : undefined;
  if (stack) attributes['exception.stacktrace'] = stack;
  span.events.push({ name: 'exception', timeMs, attributes });
}
