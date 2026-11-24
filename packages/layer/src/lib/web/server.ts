import type { IncomingMessage, ServerResponse } from 'node:http';
import { BodyCollector, headerValue, isTextContent } from '../instrumentation/http-span.js';
import type { Invocation, Tracer } from '../tracer/tracer.js';
import { webRequestTrigger } from '../triggers/detect.js';
import { redactUrl } from '../utils/redact.js';

const PATCHED = Symbol.for('ivy.http-server.patched');
const REQUEST_ID_HEADER = 'lambda-web-request-id';
const ENDPOINT_HEADER = 'lambda-web-endpoint-name';

export interface WebRequestOptions {
  /** Function name for requests (the endpoint name from the request is the fallback). */
  functionName?: string;
}

/**
 * Traces every request an `http.Server` in this process receives (Express, Hono's node server, plain `node:http`):
 * each one becomes an invocation, and the app's handling of it runs in that invocation's async context, so
 * concurrent requests keep their own calls and logs.
 */
export function instrumentServer(tracer: Tracer, options: WebRequestOptions = {}): void {
  const http = process.getBuiltinModule('node:http') as typeof import('node:http');
  const proto = http.Server.prototype as any;
  if (proto[PATCHED]) return;
  Object.defineProperty(proto, PATCHED, { value: true });
  const emit = proto.emit;
  proto.emit = function (this: unknown, event: string | symbol, ...args: any[]) {
    if (event !== 'request') return emit.call(this, event, ...args);
    let inv: Invocation | undefined;
    try {
      inv = startRequest(tracer, args[0], args[1], options);
    } catch {
      inv = undefined;
    }
    return inv ? tracer.runInvocation(inv, () => emit.call(this, event, ...args)) : emit.call(this, event, ...args);
  };
}

function startRequest(tracer: Tracer, req: IncomingMessage, res: ServerResponse, options: WebRequestOptions): Invocation | undefined {
  const headers = req.headers;
  const endpoint = headerValue(headers, ENDPOINT_HEADER);
  const url = req.url ?? '/';
  const limit = Math.max(tracer.config.maxPayloadBytes * 4, 64 * 1024);
  const requestBody = new BodyCollector(limit);
  const request: Record<string, unknown> = { method: req.method, url: redactUrl(url, tracer.isSecret), headers };

  const inv = tracer.startInvocation(
    request,
    { awsRequestId: headerValue(headers, REQUEST_ID_HEADER), functionName: options.functionName ?? endpoint },
    webRequestTrigger(req.method, url, endpoint),
  );

  // Listeners on the request and response (body parsers, 'finish' handlers) run in the parser's async context,
  // not in the one `emit('request')` ran in, so both emitters are bound to the invocation.
  const reqEmit = req.emit;
  req.emit = function (this: IncomingMessage, event: string | symbol, ...args: any[]) {
    try {
      if (event === 'data') requestBody.add(args[0], this.readableEncoding ?? undefined);
    } catch {
      // ignore
    }
    return tracer.runInvocation(inv, () => reqEmit.call(this, event, ...args));
  } as typeof req.emit;
  const resEmit = res.emit;
  res.emit = function (this: ServerResponse, event: string | symbol, ...args: any[]) {
    return tracer.runInvocation(inv, () => resEmit.call(this, event, ...args));
  } as typeof res.emit;

  const responseBody = new BodyCollector(limit);
  const write = res.write;
  res.write = function (this: ServerResponse, chunk: any, ...rest: any[]) {
    try {
      responseBody.add(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
    } catch {
      // ignore
    }
    return (write as any).call(this, chunk, ...rest);
  } as typeof res.write;
  const end = res.end;
  res.end = function (this: ServerResponse, chunk?: any, ...rest: any[]) {
    try {
      if (typeof chunk !== 'function') responseBody.add(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
    } catch {
      // ignore
    }
    return (end as any).call(this, chunk, ...rest);
  } as typeof res.end;

  const finish = (aborted: boolean) => {
    if (inv.done) return;
    try {
      const body = bodyPayload(requestBody, headerValue(headers, 'content-type'));
      if (body !== undefined) request.body = body;
      const route = expressRoute(req);
      if (route) inv.root.attributes['http.route'] = route;
      const resHeaders = res.getHeaders() as Record<string, unknown>;
      const response: Record<string, unknown> = { statusCode: res.statusCode, headers: resHeaders };
      const resBody = bodyPayload(responseBody, headerValue(resHeaders, 'content-type'));
      if (resBody !== undefined) response.body = resBody;
      if (aborted) {
        const err = new Error('The connection closed before the response was complete');
        err.name = 'ConnectionClosed';
        err.stack = undefined;
        tracer.endInvocation(inv, err, undefined);
      } else {
        tracer.endInvocation(inv, null, response);
      }
    } catch {
      // never affect the request
    }
  };
  res.once('finish', () => finish(false));
  res.once('close', () => finish(!res.writableFinished));
  return inv;
}

function bodyPayload(body: BodyCollector, contentType: string | undefined): unknown {
  if (body.total === 0 || !isTextContent(contentType)) return undefined;
  const text = body.text();
  if (body.bytes === body.total && /json/i.test(contentType ?? '')) {
    try {
      return JSON.parse(text);
    } catch {
      // keep the text
    }
  }
  return text;
}

/** The matched route pattern, when the app uses Express (`/users/:id`). */
function expressRoute(req: IncomingMessage): string | undefined {
  const r = req as IncomingMessage & { route?: { path?: unknown }; baseUrl?: unknown };
  const path = r.route?.path;
  if (typeof path !== 'string') return undefined;
  return `${typeof r.baseUrl === 'string' ? r.baseUrl : ''}${path}` || undefined;
}
