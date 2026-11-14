import {
  InvocationBuilder,
  InvocationError,
  payload,
  type Attributes,
  type FunctionResource,
  type Span,
  type SpanKind,
} from './invocation.js';
import { chance, latency, randomInt } from './random.js';

export type FaasTrigger = 'http' | 'pubsub' | 'datasource' | 'timer' | 'other';

export interface HttpRequestInfo {
  method: string;
  path: string;
  route: string;
}

export interface ScenarioContext {
  inv: InvocationBuilder;
  coldStart: boolean;
  /** Extra error probability (incidents). */
  errorBoost: number;
}

export interface ScenarioResult {
  response: unknown;
  httpStatus?: number;
}

export interface FunctionDef extends FunctionResource {
  weight: number;
  timeoutS: number;
  faasTrigger: FaasTrigger;
  triggerSource: string;
  kind: SpanKind;
  memoryUsedMb: [number, number];
  /** Builds the incoming event; HTTP functions also return method/path/route. */
  event(): { event: unknown; http?: HttpRequestInfo };
  run(ctx: ScenarioContext, event: unknown): ScenarioResult;
}

export interface GeneratedInvocation {
  resource: FunctionResource;
  spans: Span[];
  error: boolean;
}

export function generateInvocation(
  def: FunctionDef,
  startMs: number,
  opts: { coldStart: boolean; errorBoost: number },
): GeneratedInvocation {
  const inv = new InvocationBuilder(def, startMs);
  if (opts.coldStart) inv.work(latency(180, 0.4));
  inv.work(latency(1.5, 0.5));

  const { event, http } = def.event();
  const root: Attributes = {
    'ivy.invocation': true,
    'faas.invocation_id': inv.requestId,
    'faas.coldstart': opts.coldStart,
    'faas.trigger': def.faasTrigger,
    'ivy.trigger.source': def.triggerSource,
    'cloud.resource_id': `arn:aws:lambda:${def.region}:${def.accountId}:function:${def.name}`,
    'ivy.memory_used_mb': randomInt(def.memoryUsedMb[0], def.memoryUsedMb[1]) + (opts.coldStart ? 0 : randomInt(0, 6)),
  };
  if (http) {
    root['http.request.method'] = http.method;
    root['url.path'] = http.path;
    root['http.route'] = http.route;
  }
  const requestPayload = payload(event);
  root['ivy.payload.request'] = requestPayload.value;
  if (requestPayload.truncated) root['ivy.payload.truncated'] = true;

  let status: Span['status'];
  const events = inv.logs;
  try {
    const result = def.run({ inv, coldStart: opts.coldStart, errorBoost: opts.errorBoost }, event);
    inv.work(latency(1, 0.5));
    const responsePayload = payload(result.response ?? null);
    root['ivy.payload.response'] = responsePayload.value;
    if (responsePayload.truncated) root['ivy.payload.truncated'] = true;
    if (http) root['http.response.status_code'] = result.httpStatus ?? 200;
  } catch (err) {
    if (!(err instanceof InvocationError)) throw err;
    if (err.timeoutMs !== undefined) inv.cursorMs = startMs + err.timeoutMs;
    else inv.work(latency(2, 0.5));
    status = { code: 'ERROR', message: err.message };
    root['error.type'] = err.type;
    if (http) root['http.response.status_code'] = err.timeoutMs !== undefined ? 504 : 502;
    if (err.timeoutMs === undefined) {
      events.push({
        timeMs: inv.cursorMs,
        name: 'log',
        attributes: { 'log.severity': 'error', 'log.message': `${err.type}: ${err.message}` },
      });
    }
    events.push({
      timeMs: inv.cursorMs,
      name: 'exception',
      attributes: {
        'exception.type': err.type,
        'exception.message': err.message,
        'exception.stacktrace': err.stack,
      },
    });
  }

  const rootSpan: Span = {
    traceId: inv.traceId,
    spanId: inv.rootSpanId,
    parentSpanId: '',
    name: def.name,
    kind: def.kind,
    startMs,
    endMs: inv.cursorMs,
    attributes: root,
    events,
    status,
  };
  return { resource: def, spans: [rootSpan, ...inv.spans], error: status?.code === 'ERROR' };
}

/** Helper for scenarios: fail with probability `p` (plus the incident boost). */
export function maybeFail(ctx: ScenarioContext, p: number, type: string, message: string): void {
  if (chance(p + ctx.errorBoost)) throw new InvocationError(type, message);
}
