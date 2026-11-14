import { now } from '../tracer/clock.js';
import type { Tracer } from '../tracer/tracer.js';
import {
  BodyCollector,
  failHttpSpan,
  finalizeHttpSpan,
  isTextContent,
  setHttpStatus,
  shouldSkip,
  startHttpSpan,
  type HttpExchange,
  type HttpRequestInfo,
} from './http-span.js';

const MAX_RESPONSE_CAPTURE = 1024 * 1024;

function headersToObject(h: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!h) return out;
  if (typeof (h as Headers).forEach === 'function' && !Array.isArray(h)) {
    (h as Headers).forEach((v, k) => (out[k] = v));
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = v;
  } else if (typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  }
  return out;
}

function requestInfo(input: unknown, init: RequestInit | undefined): { info: HttpRequestInfo; headers: Record<string, unknown> } {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const url = new URL(isRequest ? (input as Request).url : String(input instanceof URL ? input.href : input));
  const method = String(init?.method ?? (isRequest ? (input as Request).method : 'GET')).toUpperCase();
  const headers = { ...(isRequest ? headersToObject((input as Request).headers) : {}), ...headersToObject(init?.headers) };
  return {
    info: {
      method,
      protocol: url.protocol,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname + url.search,
    },
    headers,
  };
}

export function instrumentFetch(tracer: Tracer): void {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  const wrapped = function (this: unknown, input: any, init?: RequestInit): Promise<Response> {
    if (!tracer.active) return original.call(this, input, init);
    let span: ReturnType<typeof startHttpSpan>;
    let ex: HttpExchange | undefined;
    try {
      const { info, headers } = requestInfo(input, init);
      if (!shouldSkip(info, tracer.config)) {
        span = startHttpSpan(tracer, info);
        if (span) {
          ex = { requestHeaders: () => headers };
          const body = init?.body;
          if (typeof body === 'string' || body instanceof URLSearchParams || body instanceof Uint8Array) {
            ex.requestBody = new BodyCollector(Math.max(tracer.config.maxPayloadBytes * 4, 64 * 1024));
            ex.requestBody.add(body instanceof URLSearchParams ? body.toString() : body);
            if (body instanceof URLSearchParams && !headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
          }
          finalizeHttpSpan(tracer, span, ex);
        }
      }
    } catch {
      span = undefined;
    }
    const promise = original.call(this, input, init);
    if (span && ex) {
      const s = span;
      const exchange = ex;
      promise.then(
        (res) => {
          try {
            setHttpStatus(s, res.status);
            exchange.responseHeaders = headersToObject(res.headers);
            const type = res.headers.get('content-type');
            const length = Number(res.headers.get('content-length') ?? NaN);
            const capture = res.body && isTextContent(type) && !(length > MAX_RESPONSE_CAPTURE);
            if (!capture) {
              s.endMs = now();
              return;
            }
            res
              .clone()
              .text()
              .then(
                (text) => {
                  exchange.responseBodyText = text;
                  s.endMs ??= now();
                },
                () => {
                  s.endMs ??= now();
                },
              );
          } catch {
            s.endMs ??= now();
          }
        },
        (err) => failHttpSpan(s, err),
      );
    }
    return promise;
  };
  Object.defineProperty(wrapped, 'name', { value: 'fetch' });
  globalThis.fetch = wrapped as typeof fetch;
}
