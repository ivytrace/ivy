export const DEFAULT_REDACT_KEYS =
  'password,secret,token,authorization,cookie,apikey,api_key,accesskey,secretaccesskey,sessiontoken,creditcard,cardnumber,cvv';

export interface Config {
  endpoint: string | undefined;
  tracesUrl: string | undefined;
  apiKey: string | undefined;
  enabled: boolean;
  debug: boolean;
  maxPayloadBytes: number;
  redactKeys: string[];
  extensionPort: number;
  timeoutMarginMs: number;
  exportTimeoutMs: number;
  flushBudgetMs: number;
  flushBudgetPerChunkMs: number;
  flushBudgetMaxMs: number;
  exportChunkSpans: number;
  exportChunkBytes: number;
  maxQueueSpans: number;
  captureLogs: boolean;
  maxSpans: number;
  maxInvocationPayloadBytes: number;
  collapseThreshold: number;
  collapseKeep: number;
  collapseKeepSlowest: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

export function tracesUrl(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  const base = endpoint.replace(/\/+$/, '');
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const endpoint = env.IVY_ENDPOINT || undefined;
  return {
    endpoint,
    tracesUrl: tracesUrl(endpoint),
    apiKey: env.IVY_API_KEY || undefined,
    enabled: !!endpoint && !bool(env.IVY_DISABLE, false),
    debug: bool(env.IVY_DEBUG, false),
    maxPayloadBytes: int(env.IVY_MAX_PAYLOAD_BYTES, 16 * 1024),
    redactKeys: (env.IVY_REDACT_KEYS ?? DEFAULT_REDACT_KEYS)
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    extensionPort: int(env.IVY_EXTENSION_PORT, 9790),
    timeoutMarginMs: int(env.IVY_TIMEOUT_MARGIN_MS, 100),
    exportTimeoutMs: int(env.IVY_EXPORT_TIMEOUT_MS, 1000),
    flushBudgetMs: int(env.IVY_FLUSH_BUDGET_MS, 2000),
    flushBudgetPerChunkMs: int(env.IVY_FLUSH_BUDGET_PER_CHUNK_MS, 500),
    flushBudgetMaxMs: int(env.IVY_FLUSH_BUDGET_MAX_MS, 5000),
    exportChunkSpans: Math.max(1, int(env.IVY_EXPORT_CHUNK_SPANS, 500)),
    exportChunkBytes: Math.max(16 * 1024, int(env.IVY_EXPORT_CHUNK_BYTES, 1024 * 1024)),
    maxQueueSpans: int(env.IVY_MAX_QUEUE_SPANS, 2000),
    captureLogs: bool(env.IVY_CAPTURE_LOGS, true),
    maxSpans: Math.max(10, int(env.IVY_MAX_SPANS, 2000)),
    maxInvocationPayloadBytes: int(env.IVY_MAX_INVOCATION_PAYLOAD_BYTES, 1024 * 1024),
    collapseThreshold: int(env.IVY_COLLAPSE_THRESHOLD, 50),
    collapseKeep: int(env.IVY_COLLAPSE_KEEP, 10),
    collapseKeepSlowest: int(env.IVY_COLLAPSE_KEEP_SLOWEST, 3),
  };
}
