import http from 'node:http';
import type { FailureLimiter } from './failure-limiter.js';
import { forward, type Forwarded } from './forward.js';
import type { QuotaGate } from '../limits/quota-gate.js';
import type { KeyCache } from './key-cache.js';
import { countTraffic, decode, formatOf, GrpcCode, PayloadTooLargeError, statusBody, type OtlpFormat } from './otlp.js';
import type { UsageCounters } from './usage.js';

export const TENANT_HEADER = 'x-ivy-tenant';
export const PROJECT_HEADER = 'x-ivy-project';

export interface IngestOptions {
  keys: KeyCache;
  limiter: FailureLimiter;
  usage: UsageCounters;
  /** Monthly trace quotas (docs/implementation/limits.md). Without it nothing is limited. */
  quota?: QuotaGate;
  /** OTLP/HTTP base URL of a shard's collector. */
  collectorUrl: (shardId: string) => string;
  /** Shared secret the internal collectors accept (bearertokenauth). */
  collectorToken: string;
  maxBodyBytes?: number;
  maxDecodedBytes?: number;
  upstreamTimeoutMs?: number;
  /** Take the client IP from X-Forwarded-For (only behind a proxy that sets it). */
  trustProxy?: boolean;
  log?: (msg: string) => void;
}

const RETRY_AFTER_S = 5;

class HttpError extends Error {
  constructor(
    public status: number,
    public code: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function apiKeyOf(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    return match ? match[1].trim() : null;
  }
  const header = req.headers['x-api-key'];
  return (Array.isArray(header) ? header[0] : header)?.trim() || null;
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new HttpError(413, GrpcCode.INVALID_ARGUMENT, `Body larger than ${max} bytes`));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, format: OtlpFormat | null, err: HttpError, close: boolean) {
  const { body, contentType } = statusBody(format, err.code, err.message);
  const headers: Record<string, string | number> = { 'content-type': contentType, 'content-length': body.length };
  if (err.retryAfter) headers['retry-after'] = err.retryAfter;
  if (close) headers.connection = 'close';
  res.writeHead(err.status, headers);
  res.end(body);
}

/**
 * OTLP/HTTP ingest router: authenticates the API key, resolves its tenant, project and shard, and
 * forwards the request body unchanged to that shard's collector with the tenant in `x-ivy-tenant`
 * and the project in `x-ivy-project`.
 * See docs/implementation/tenancy.md.
 */
export function createIngestHandler(opts: IngestOptions): http.RequestListener {
  const maxBody = opts.maxBodyBytes ?? 10 * 1024 * 1024;
  const maxDecoded = opts.maxDecodedBytes ?? 64 * 1024 * 1024;
  const timeoutMs = opts.upstreamTimeoutMs ?? 15_000;

  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const format = formatOf(req.headers['content-type']);
    let bodyRead = false;
    try {
      if (path === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (path === '/v1/logs' || path === '/v1/metrics') {
        throw new HttpError(404, GrpcCode.UNIMPLEMENTED, `${path} is not supported; Ivy ingests traces only`);
      }
      if (path !== '/v1/traces') throw new HttpError(404, GrpcCode.NOT_FOUND, 'Not found');
      if (req.method !== 'POST') throw new HttpError(405, GrpcCode.UNIMPLEMENTED, 'Use POST');

      const ip = clientIp(req, !!opts.trustProxy);
      const key = apiKeyOf(req);
      if (!key) throw new HttpError(401, GrpcCode.UNAUTHENTICATED, 'Missing API key (Authorization: Bearer <key>)');
      const blocked = opts.limiter.blockedFor(ip);
      if (blocked && !opts.keys.peek(key)) {
        throw new HttpError(429, GrpcCode.RESOURCE_EXHAUSTED, 'Too many invalid API keys', blocked);
      }
      let tenant;
      try {
        tenant = await opts.keys.resolve(key);
      } catch (err) {
        opts.log?.(`key lookup failed: ${(err as Error).message}`);
        throw new HttpError(503, GrpcCode.UNAVAILABLE, 'Key lookup unavailable', RETRY_AFTER_S);
      }
      if (!tenant) {
        opts.limiter.fail(ip);
        throw new HttpError(401, GrpcCode.UNAUTHENTICATED, 'Invalid API key');
      }

      const blockedByQuota = await opts.quota?.check(tenant.tenantId, tenant.shardId);
      if (blockedByQuota) throw new HttpError(429, GrpcCode.RESOURCE_EXHAUSTED, blockedByQuota.message, blockedByQuota.retryAfter);

      if (!format) throw new HttpError(415, GrpcCode.INVALID_ARGUMENT, 'Use application/x-protobuf or application/json');
      if (Number(req.headers['content-length'] ?? 0) > maxBody) {
        throw new HttpError(413, GrpcCode.INVALID_ARGUMENT, `Body larger than ${maxBody} bytes`);
      }
      const body = await readBody(req, maxBody);
      bodyRead = true;
      const encoding = req.headers['content-encoding'];
      let traffic;
      try {
        traffic = countTraffic(await decode(body, encoding, maxDecoded), format);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) throw new HttpError(413, GrpcCode.INVALID_ARGUMENT, err.message);
        throw new HttpError(400, GrpcCode.INVALID_ARGUMENT, `Malformed request: ${(err as Error).message}`);
      }

      let upstream: Forwarded;
      try {
        const headers: Record<string, string> = {
          'content-type': req.headers['content-type']!,
          authorization: `Bearer ${opts.collectorToken}`,
          [TENANT_HEADER]: tenant.tenantId,
          [PROJECT_HEADER]: tenant.projectId,
        };
        if (encoding) headers['content-encoding'] = encoding;
        upstream = await forward(`${opts.collectorUrl(tenant.shardId)}/v1/traces`, headers, body, timeoutMs);
      } catch (err) {
        opts.log?.(`collector ${tenant.shardId} unreachable: ${(err as Error).message}`);
        throw new HttpError(503, GrpcCode.UNAVAILABLE, 'Ingest temporarily unavailable', RETRY_AFTER_S);
      }

      const ok = upstream.status >= 200 && upstream.status < 300;
      if (ok) {
        opts.usage.add(tenant.tenantId, traffic.spans, body.length);
        opts.quota?.add(tenant.tenantId, traffic.invocations);
      }
      else opts.log?.(`collector ${tenant.shardId} answered ${upstream.status} for ${tenant.tenantId}`);
      // The collector only ever sees our token: its 401/403 is our misconfiguration, not the client's.
      const status = upstream.status === 401 || upstream.status === 403 ? 503 : upstream.status;
      const headers: Record<string, string | number> = {
        'content-type': upstream.headers['content-type'] ?? (format === 'json' ? 'application/json' : 'application/x-protobuf'),
        'content-length': upstream.body.length,
      };
      const upstreamRetryAfter = upstream.headers['retry-after'];
      const retryAfter = upstreamRetryAfter ?? (status === 429 || status === 503 ? String(RETRY_AFTER_S) : null);
      if (retryAfter) headers['retry-after'] = retryAfter;
      res.writeHead(status, headers).end(upstream.body);
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, format, err, !bodyRead);
        return;
      }
      opts.log?.(`ingest error: ${(err as Error).stack ?? err}`);
      send(res, format, new HttpError(500, GrpcCode.UNAVAILABLE, 'Internal error'), !bodyRead);
    }
  };
}
