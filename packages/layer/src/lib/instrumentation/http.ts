import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { now } from '../tracer/clock.js';
import type { Tracer } from '../tracer/tracer.js';
import {
  BodyCollector,
  failHttpSpan,
  finalizeHttpSpan,
  setHttpStatus,
  shouldSkip,
  SKIP_HTTP,
  startHttpSpan,
  type HttpExchange,
  type HttpRequestInfo,
} from './http-span.js';

type RequestFn = (...args: any[]) => ClientRequest;

function parseArgs(args: any[], defaultProtocol: string): { info: HttpRequestInfo; headers: any } | undefined {
  let url: URL | undefined;
  let options: RequestOptions & { href?: string } = {};
  const [a, b] = args;
  if (typeof a === 'string') url = new URL(a);
  else if (a instanceof URL) url = a;
  else if (a && typeof a === 'object') options = a;
  if (url && b && typeof b === 'object' && typeof b !== 'function') options = b;

  const protocol = options.protocol ?? url?.protocol ?? defaultProtocol;
  let host = options.hostname ?? (options.host ? String(options.host).replace(/:\d+$/, '') : undefined) ?? url?.hostname ?? 'localhost';
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const portRaw = options.port ?? (url?.port || undefined);
  const port = portRaw !== undefined && portRaw !== null && portRaw !== '' ? Number(portRaw) : undefined;
  const path = options.path ?? (url ? url.pathname + url.search : '/');
  const method = String(options.method ?? 'GET').toUpperCase();
  return { info: { method, protocol, host, port, path }, headers: options.headers };
}

function instrumentRequest(tracer: Tracer, req: ClientRequest, info: HttpRequestInfo): void {
  const span = startHttpSpan(tracer, info);
  if (!span) return;
  const limit = Math.max(tracer.config.maxPayloadBytes * 4, 64 * 1024);
  const ex: HttpExchange = {
    requestHeaders: () => req.getHeaders() as Record<string, unknown>,
    requestBody: new BodyCollector(limit),
  };
  finalizeHttpSpan(tracer, span, ex);

  const write = req.write;
  req.write = function (this: ClientRequest, chunk: any, ...rest: any[]) {
    try {
      ex.requestBody!.add(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
    } catch {
      // ignore
    }
    return (write as any).call(this, chunk, ...rest);
  } as typeof req.write;
  const end = req.end;
  req.end = function (this: ClientRequest, chunk?: any, ...rest: any[]) {
    try {
      if (typeof chunk !== 'function') ex.requestBody!.add(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
    } catch {
      // ignore
    }
    return (end as any).call(this, chunk, ...rest);
  } as typeof req.end;

  const emit = req.emit;
  req.emit = function (this: ClientRequest, event: string | symbol, ...args: any[]) {
    try {
      if (event === 'response') onResponse(args[0]);
      else if (event === 'error') failHttpSpan(span, args[0]);
      else if (event === 'close' && span.endMs === undefined && !ex.responseHeaders) failHttpSpan(span, new Error('socket closed before response'));
    } catch {
      // ignore
    }
    return emit.call(this, event, ...args);
  } as typeof req.emit;

  function onResponse(res: IncomingMessage) {
    setHttpStatus(span!, res.statusCode ?? 0);
    ex.responseHeaders = res.headers as Record<string, unknown>;
    ex.responseBody = new BodyCollector(limit);
    const resEmit = res.emit;
    res.emit = function (this: IncomingMessage, event: string | symbol, ...args: any[]) {
      try {
        if (event === 'data') ex.responseBody!.add(args[0], (res as any).readableEncoding ?? undefined);
        else if (event === 'end' && span!.endMs === undefined) span!.endMs = now();
        else if (event === 'error') failHttpSpan(span!, args[0]);
      } catch {
        // ignore
      }
      return resEmit.call(this, event, ...args);
    } as typeof res.emit;
  }
}

function wrap(tracer: Tracer, original: RequestFn, protocol: string): RequestFn {
  return function (this: unknown, ...args: any[]) {
    if (!tracer.active) return original.apply(this, args);
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs(args, protocol);
      if (parsed && (parsed.headers?.[SKIP_HTTP] || shouldSkip(parsed.info, tracer.config))) parsed = undefined;
    } catch {
      parsed = undefined;
    }
    const req = original.apply(this, args);
    if (parsed) {
      try {
        instrumentRequest(tracer, req, parsed.info);
      } catch {
        // instrumentation must never break the request
      }
    }
    return req;
  };
}

export function instrumentHttp(tracer: Tracer): void {
  const require = createRequire(import.meta.url);
  for (const [name, protocol] of [
    ['http', 'http:'],
    ['https', 'https:'],
  ] as const) {
    const mod = require(name);
    mod.request = wrap(tracer, mod.request, protocol);
    mod.get = wrap(tracer, mod.get, protocol);
  }
  syncBuiltinESMExports();
}
