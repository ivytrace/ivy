import { spanId as newSpanId, traceId as newTraceId } from './ids.js';
import { latency, pick, randomInt, uuid } from './random.js';

export type AttrValue = string | number | boolean | string[];
export type Attributes = Record<string, AttrValue>;

export type SpanKind = 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';

export interface SpanEvent {
  timeMs: number;
  name: string;
  attributes: Attributes;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs: number;
  attributes: Attributes;
  events: SpanEvent[];
  status?: { code: 'OK' | 'ERROR'; message?: string };
}

export interface FunctionResource {
  name: string;
  region: string;
  accountId: string;
  memoryMb: number;
}

/** Thrown from a scenario to end the invocation with an error. */
export class InvocationError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly stack: string = `${type}: ${message}\n    at handler (/var/task/index.js:${randomInt(10, 400)}:${randomInt(5, 40)})\n    at Runtime.handleOnceNonStreaming (file:///var/runtime/index.mjs:1173:29)`,
    readonly timeoutMs?: number,
  ) {
    super(message);
  }
}

const MAX_PAYLOAD_BYTES = 16 * 1024;

export function payload(value: unknown): { value: string; truncated: boolean } {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const bytes = Buffer.byteLength(json);
  if (bytes <= MAX_PAYLOAD_BYTES) return { value: json, truncated: false };
  const kept = Buffer.from(json).subarray(0, MAX_PAYLOAD_BYTES).toString('utf8');
  return { value: `${kept}…[truncated ${bytes - MAX_PAYLOAD_BYTES} bytes]`, truncated: true };
}

function withPayloads(attributes: Attributes, request: unknown, response: unknown): Attributes {
  const out = { ...attributes };
  if (request !== undefined) {
    const p = payload(request);
    out['ivy.payload.request'] = p.value;
    if (p.truncated) out['ivy.payload.truncated'] = true;
  }
  if (response !== undefined) {
    const p = payload(response);
    out['ivy.payload.response'] = p.value;
    if (p.truncated) out['ivy.payload.truncated'] = true;
  }
  return out;
}

export interface AwsCall {
  ms: number;
  attributes?: Attributes;
  request?: unknown;
  response?: unknown;
  error?: { type: string; message: string; statusCode: number };
}

export interface HttpCall {
  ms: number;
  status: number;
  request?: unknown;
  response?: unknown;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

/** Builds the spans of one invocation; time advances as calls are made. */
export class InvocationBuilder {
  readonly traceId: string;
  readonly rootSpanId = newSpanId();
  readonly requestId = uuid();
  cursorMs: number;
  readonly spans: Span[] = [];
  readonly logs: SpanEvent[] = [];

  constructor(
    readonly fn: FunctionResource,
    readonly startMs: number,
  ) {
    this.traceId = newTraceId(startMs);
    this.cursorMs = startMs;
  }

  work(ms: number): void {
    this.cursorMs += Math.max(0.05, ms);
  }

  log(severity: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.work(latency(0.3, 0.5));
    this.logs.push({ timeMs: this.cursorMs, name: 'log', attributes: { 'log.severity': severity, 'log.message': message } });
  }

  aws(service: string, operation: string, call: AwsCall): void {
    this.work(latency(0.4, 0.4));
    const startMs = this.cursorMs;
    const endMs = startMs + call.ms;
    const statusCode = call.error?.statusCode ?? 200;
    const span: Span = {
      traceId: this.traceId,
      spanId: newSpanId(),
      parentSpanId: this.rootSpanId,
      name: `${service}.${operation}`,
      kind: 'CLIENT',
      startMs,
      endMs,
      attributes: withPayloads(
        {
          'rpc.system': 'aws-api',
          'rpc.service': service,
          'rpc.method': operation,
          'cloud.region': this.fn.region,
          'aws.request_id': uuid().toUpperCase().replaceAll('-', '').slice(0, 32),
          'http.response.status_code': statusCode,
          ...call.attributes,
        },
        call.request,
        call.error ? { name: call.error.type, message: call.error.message, $metadata: { httpStatusCode: statusCode } } : call.response,
      ),
      events: [],
    };
    if (call.error) {
      span.status = { code: 'ERROR', message: call.error.message };
      span.attributes['error.type'] = call.error.type;
      span.events.push({
        timeMs: endMs,
        name: 'exception',
        attributes: { 'exception.type': call.error.type, 'exception.message': call.error.message },
      });
    }
    this.spans.push(span);
    this.cursorMs = endMs;
  }

  http(method: string, url: string, call: HttpCall): void {
    this.work(latency(0.4, 0.4));
    const parsed = new URL(url);
    const startMs = this.cursorMs;
    const endMs = startMs + call.ms;
    const span: Span = {
      traceId: this.traceId,
      spanId: newSpanId(),
      parentSpanId: this.rootSpanId,
      name: `${method} ${parsed.host}`,
      kind: 'CLIENT',
      startMs,
      endMs,
      attributes: withPayloads(
        {
          'http.request.method': method,
          'url.full': url,
          'server.address': parsed.hostname,
          'server.port': parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
          'http.response.status_code': call.status,
          'ivy.http.request.headers': JSON.stringify({
            'content-type': 'application/json',
            'user-agent': 'node',
            ...call.requestHeaders,
          }),
          'ivy.http.response.headers': JSON.stringify({
            'content-type': 'application/json',
            date: new Date(endMs).toUTCString(),
            ...call.responseHeaders,
          }),
        },
        call.request,
        call.response,
      ),
      events: [],
    };
    if (call.status >= 500) {
      span.status = { code: 'ERROR', message: `HTTP ${call.status}` };
      span.attributes['error.type'] = String(call.status);
    }
    this.spans.push(span);
    this.cursorMs = endMs;
  }

  /** Runs calls as if concurrent (Promise.all): all start now, cursor moves to the slowest. */
  parallel(calls: Array<() => void>): void {
    const start = this.cursorMs;
    let end = start;
    for (const call of calls) {
      this.cursorMs = start;
      call();
      end = Math.max(end, this.cursorMs);
    }
    this.cursorMs = end;
  }
}

export const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'okhttp/4.12.0',
];

export function sourceIp(): string {
  return pick(['84.241', '145.53', '31.20', '62.45', '213.127']) + `.${randomInt(1, 254)}.${randomInt(1, 254)}`;
}
