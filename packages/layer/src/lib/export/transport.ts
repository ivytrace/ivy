import { unwrapped } from '../utils/original.js';

// Builtins are loaded on first use: https/tls and zlib cost several ms, and this path only runs
// after a response (export to the extension, or directly when it is missing).
let agents: { http: import('node:http').Agent; https: import('node:https').Agent } | undefined;
const getAgents = () =>
  (agents ??= {
    http: new (process.getBuiltinModule('node:http').Agent)({ keepAlive: true, maxSockets: 2 }),
    https: new (process.getBuiltinModule('node:https').Agent)({ keepAlive: true, maxSockets: 2 }),
  });

export interface PostResult {
  status: number;
  body: string;
  retryAfter?: string;
}

export interface PostOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  gzip?: boolean;
  keepAlive?: boolean;
}

export function post(url: string, body: string, opts: PostOptions): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };
    const timer = setTimeout(() => {
      done(() => reject(new Error(`timeout after ${opts.timeoutMs}ms`)));
      req.destroy();
    }, opts.timeoutMs);
    let payload: Buffer = Buffer.from(body, 'utf8');
    const headers: Record<string, string | number> = { 'content-type': 'application/json', ...opts.headers };
    if (opts.gzip && payload.length > 1024) {
      payload = process.getBuiltinModule('node:zlib').gzipSync(payload);
      headers['content-encoding'] = 'gzip';
    }
    headers['content-length'] = payload.length;
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const request = unwrapped(process.getBuiltinModule(isHttps ? 'node:https' : 'node:http').request);
    const agent = opts.keepAlive === false ? false : isHttps ? getAgents().https : getAgents().http;
    const req = request(u, { method: 'POST', headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        done(() =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            retryAfter: [res.headers['retry-after']].flat()[0],
          }),
        ),
      );
      res.on('error', (err) => done(() => reject(err)));
    });
    req.on('error', (err) => done(() => reject(err)));
    req.end(payload);
  });
}

export function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** `Retry-After` as milliseconds: delay-seconds or an HTTP date. Undefined when absent or unparsable. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export interface SendResult {
  ok: boolean;
  /** The server asked to wait (429/503 with Retry-After): don't send before then. */
  retryAfterMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Posts with retries on network errors / retryable statuses, bounded by a total budget. A 429 or
 * 503 with Retry-After ends the attempts at once and passes the delay on, so a client over its
 * quota doesn't retry within the flush.
 */
export async function postWithRetry(
  url: string,
  body: string,
  opts: PostOptions & { budgetMs: number; attempts?: number; onError?: (msg: string) => void },
): Promise<SendResult> {
  const deadline = Date.now() + opts.budgetMs;
  const attempts = opts.attempts ?? 3;
  for (let i = 0; i < attempts; i++) {
    const remaining = deadline - Date.now();
    if (remaining < 50) break;
    try {
      const res = await post(url, body, { ...opts, timeoutMs: Math.min(opts.timeoutMs, remaining) });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      opts.onError?.(`export failed with HTTP ${res.status}: ${res.body.slice(0, 200)}`);
      if (!isRetryable(res.status)) return { ok: false };
      const retryAfterMs = res.status === 429 || res.status === 503 ? parseRetryAfter(res.retryAfter) : undefined;
      if (retryAfterMs !== undefined) return { ok: false, retryAfterMs };
    } catch (err) {
      opts.onError?.(`export failed: ${(err as Error).message}`);
    }
    const backoff = 100 * 3 ** i;
    if (Date.now() + backoff >= deadline) break;
    await sleep(backoff);
  }
  return { ok: false };
}
