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
  maxQueueSpans: number;
  captureLogs: boolean;
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
    exportTimeoutMs: int(env.IVY_EXPORT_TIMEOUT_MS, 1500),
    flushBudgetMs: int(env.IVY_FLUSH_BUDGET_MS, 2500),
    maxQueueSpans: int(env.IVY_MAX_QUEUE_SPANS, 2000),
    captureLogs: bool(env.IVY_CAPTURE_LOGS, true),
  };
}
