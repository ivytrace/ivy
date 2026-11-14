import type { Config } from '../config/config.js';
import { now } from '../tracer/clock.js';
import { recordError, StatusCode, type Span } from '../tracer/span.js';
import type { Tracer } from '../tracer/tracer.js';
import { redactHeaders, redactUrl } from '../utils/redact.js';
import { awsServiceAttributes, operationFromHttp, parseSigV4, serviceFromSigningName } from './aws-attributes.js';

/** Marks HTTP requests issued by an instrumented AWS SDK client, which already has its own span. */
export const SKIP_HTTP = Symbol.for('ivy.skip-http');

export interface HttpRequestInfo {
  method: string;
  protocol: string;
  host: string;
  port?: number;
  path: string;
}

export type HeaderBag = Record<string, unknown>;

export class BodyCollector {
  private chunks: Buffer[] = [];
  bytes = 0;
  total = 0;
  constructor(private limit: number) {}

  add(chunk: unknown, encoding?: string): void {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    let buf: Buffer;
    if (typeof chunk === 'string') buf = Buffer.from(chunk, encoding && Buffer.isEncoding(encoding) ? (encoding as BufferEncoding) : 'utf8');
    else if (chunk instanceof Uint8Array) buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    else return;
    this.total += buf.length;
    if (this.bytes < this.limit) {
      const part = buf.length + this.bytes > this.limit ? buf.subarray(0, this.limit - this.bytes) : buf;
      this.chunks.push(Buffer.from(part));
      this.bytes += part.length;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

const TEXTY = /json|text|xml|x-www-form-urlencoded|graphql|javascript/i;

export function isTextContent(contentType: unknown): boolean {
  return contentType === undefined || contentType === null || contentType === '' || TEXTY.test(String(contentType));
}

export function headerValue(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (v !== undefined) return Array.isArray(v) ? v.join(', ') : String(v);
  const lower = name.toLowerCase();
  for (const k in headers) if (k.toLowerCase() === lower) return String(headers[k]);
  return undefined;
}

let runtimeApi: string | undefined;

export function shouldSkip(info: HttpRequestInfo, config: Config): boolean {
  const host = info.host.toLowerCase();
  const port = info.port ?? (info.protocol === 'https:' ? 443 : 80);
  const hostPort = `${host}:${port}`;
  runtimeApi ??= (process.env.AWS_LAMBDA_RUNTIME_API ?? '127.0.0.1:9001').toLowerCase();
  if (hostPort === runtimeApi) return true;
  if ((host === '127.0.0.1' || host === 'localhost') && port === config.extensionPort) return true;
  if (host === 'sandbox.localdomain' || host === 'sandbox') return true;
  if (config.endpoint) {
    try {
      const e = new URL(config.endpoint);
      const ePort = e.port ? Number(e.port) : e.protocol === 'https:' ? 443 : 80;
      if (e.hostname.toLowerCase() === host && ePort === port) return true;
    } catch {
      // ignore malformed endpoint
    }
  }
  return false;
}

export function formatUrl(info: HttpRequestInfo): string {
  const defaultPort = info.protocol === 'https:' ? 443 : 80;
  const port = info.port && info.port !== defaultPort ? `:${info.port}` : '';
  const host = info.host.includes(':') && !info.host.startsWith('[') ? `[${info.host}]` : info.host;
  return `${info.protocol}//${host}${port}${info.path || '/'}`;
}

export function startHttpSpan(tracer: Tracer, info: HttpRequestInfo): Span | undefined {
  const span = tracer.startChild(`${info.method} ${info.host}`);
  if (!span) return undefined;
  span.attributes['http.request.method'] = info.method;
  span.attributes['url.full'] = redactUrl(formatUrl(info), tracer.isSecret);
  span.attributes['server.address'] = info.host;
  span.attributes['server.port'] = info.port ?? (info.protocol === 'https:' ? 443 : 80);
  return span;
}

export interface HttpExchange {
  requestHeaders?: () => HeaderBag | undefined;
  responseHeaders?: HeaderBag;
  requestBody?: BodyCollector;
  responseBody?: BodyCollector;
  responseBodyText?: string;
}

export function setHttpStatus(span: Span, status: number): void {
  span.attributes['http.response.status_code'] = status;
  if (status >= 400) span.status = { code: StatusCode.ERROR, message: `HTTP ${status}` };
}

export function failHttpSpan(span: Span, err: unknown): void {
  if (span.endMs !== undefined) return;
  recordError(span, err, now());
  span.endMs = now();
}

/** Installs the flush-time hook that turns captured headers/bodies into attributes. */
export function finalizeHttpSpan(tracer: Tracer, span: Span, ex: HttpExchange): void {
  span.finalize = () => {
    const reqHeaders = ex.requestHeaders?.();
    span.attributes['ivy.http.request.headers'] = redactHeaders(reqHeaders, tracer.isSecret);
    if (ex.responseHeaders) span.attributes['ivy.http.response.headers'] = redactHeaders(ex.responseHeaders, tracer.isSecret);

    const reqType = headerValue(reqHeaders, 'content-type');
    const resType = headerValue(ex.responseHeaders, 'content-type');
    const reqBody = ex.requestBody && ex.requestBody.total > 0 && isTextContent(reqType) ? ex.requestBody.text() : undefined;
    const resBody =
      ex.responseBodyText ??
      (ex.responseBody && ex.responseBody.total > 0 && isTextContent(resType) ? ex.responseBody.text() : undefined);
    if (reqBody !== undefined) span.payloads.push({ key: 'ivy.payload.request', value: reqBody, rawContentType: reqType ?? '' });
    if (resBody !== undefined) span.payloads.push({ key: 'ivy.payload.response', value: resBody, rawContentType: resType ?? '' });

    enrichAwsHttpSpan(span, reqHeaders, ex.responseHeaders, reqBody, resBody);
  };
}

/** Recognizes SigV4-signed calls from AWS SDK copies we could not patch (e.g. bundled ones). */
function enrichAwsHttpSpan(
  span: Span,
  reqHeaders: HeaderBag | undefined,
  resHeaders: HeaderBag | undefined,
  reqBody: string | undefined,
  resBody: string | undefined,
): void {
  const sig = parseSigV4(headerValue(reqHeaders, 'authorization'));
  if (!sig) return;
  const service = serviceFromSigningName(sig.service);
  const operation = operationFromHttp(headerValue(reqHeaders, 'x-amz-target'), reqBody);
  span.attributes['rpc.system'] = 'aws-api';
  span.attributes['rpc.service'] = service;
  span.attributes['cloud.region'] = sig.region;
  if (operation) {
    span.attributes['rpc.method'] = operation;
    span.name = `${service}.${operation}`;
  }
  const requestId = headerValue(resHeaders, 'x-amzn-requestid') ?? headerValue(resHeaders, 'x-amz-request-id');
  if (requestId) span.attributes['aws.request_id'] = requestId;
  const parse = (s: string | undefined) => {
    if (!s) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let input = parse(reqBody);
  if (!input && service === 'S3') {
    const url = String(span.attributes['url.full'] ?? '');
    const m = /^https?:\/\/([^/]+)\/([^?]*)/.exec(url);
    if (m) {
      const host = m[1];
      const virtual = /^(.+)\.s3[.-]/.exec(host);
      const parts = m[2].split('/');
      input = virtual ? { Bucket: virtual[1], Key: m[2] || undefined } : { Bucket: parts[0], Key: parts.slice(1).join('/') || undefined };
    }
  }
  Object.assign(span.attributes, awsServiceAttributes(service, input, parse(resBody), sig.region));
}
