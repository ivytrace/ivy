export const REDACTED = '[redacted]';

const normalize = (key: string) => key.toLowerCase().replace(/[-_]/g, '');

/**
 * Token *counts* (`max_tokens`, `input_tokens`, `inputTokens`, `cache_read_input_tokens`, `tokenCount`,
 * `x-amzn-bedrock-output-token-count`, `completion_tokens_details`) are not secrets, although they contain
 * the default key `token`: a normalized key ending in `tokens`, `tokencount(s)`, `tokensdetails` or
 * `tokenusage` is a count, unless the part before it names a credential (`accessTokens`, `apiTokens`, …).
 */
const COUNT_KEY = /(tokens|tokencounts?|tokensdetails|tokenusage)$/;
const CREDENTIAL_PREFIX = /(access|refresh|session|id|api|auth|bearer|oauth|csrf|xsrf|client|device|push|secret|security|reset|invite|verification|bot)$/;

export function isTokenCountKey(key: string): boolean {
  const k = normalize(key);
  const m = COUNT_KEY.exec(k);
  return !!m && !CREDENTIAL_PREFIX.test(k.slice(0, m.index));
}

/**
 * Whether a key (with its value) must be redacted. Numbers and booleans are kept when the key matched only
 * through a `token` entry (`tokenLimit: 4096`): secrets are strings. Other entries (`cardnumber`, `cvv`,
 * `password`) redact numbers too.
 */
export type KeyMatcher = (key: string, value?: unknown) => boolean;

const NOT_SECRET = 0;
const TOKEN_ONLY = 1;
const SECRET = 2;

export function createKeyMatcher(keys: string[]): KeyMatcher {
  const needles = [...new Set(keys.map(normalize).filter(Boolean))];
  const cache = new Map<string, number>();
  const classify = (key: string): number => {
    let hit = cache.get(key);
    if (hit === undefined) {
      const k = normalize(key);
      const matched = isTokenCountKey(k) ? [] : needles.filter((n) => k.includes(n));
      hit = !matched.length ? NOT_SECRET : matched.every((n) => n.includes('token')) ? TOKEN_ONLY : SECRET;
      if (cache.size < 5000) cache.set(key, hit);
    }
    return hit;
  };
  return (key: string, value?: unknown) => {
    const hit = classify(key);
    if (hit === TOKEN_ONLY) return !(typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean');
    return hit === SECRET;
  };
}

export interface Capped {
  text: string;
  truncated: boolean;
}

export function capString(text: string, maxBytes: number): Capped {
  if (text.length <= maxBytes / 3) return { text, truncated: false };
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let kept = buf.subarray(0, maxBytes).toString('utf8');
  if (kept.endsWith('�')) kept = kept.replace(/�+$/, '');
  const dropped = buf.length - Buffer.byteLength(kept, 'utf8');
  return { text: `${kept}…[truncated ${dropped} bytes]`, truncated: true };
}

const MAX_DECODE_BYTES = 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function decodeBinary(bytes: Uint8Array): unknown {
  if (bytes.byteLength <= MAX_DECODE_BYTES) {
    try {
      const text = decoder.decode(bytes);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch {
      // not valid utf-8
    }
  }
  return `[binary ${bytes.byteLength} bytes]`;
}

function isStream(v: any): boolean {
  return typeof v.pipe === 'function' || typeof v.getReader === 'function' || typeof v.on === 'function';
}

/** JSON-serializes a value with key redaction at any depth, then caps it. */
export function serialize(value: unknown, maxBytes: number, isSecret: KeyMatcher): Capped {
  if (value === undefined) return { text: '', truncated: false };
  const seen = new WeakSet<object>();
  let json: string | undefined;
  try {
    json = JSON.stringify(value, function (this: any, key: string, v: unknown) {
      if (key !== '' && isSecret(key, v)) return REDACTED;
      const original = key === '' ? value : this[key];
      if (original !== null && typeof original === 'object') {
        if (original instanceof Uint8Array) return decodeBinary(original);
        if (original instanceof ArrayBuffer) return decodeBinary(new Uint8Array(original));
        if (original instanceof Error) {
          return { name: original.name, message: original.message };
        }
        if (seen.has(original)) return '[circular]';
        seen.add(original);
        if (!Array.isArray(original) && !(original instanceof Date) && isStream(original)) return '[stream]';
      }
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'function' || typeof v === 'symbol') return undefined;
      return v;
    });
  } catch (err) {
    json = JSON.stringify(`[unserializable: ${(err as Error)?.message}]`);
  }
  return capString(json ?? '', maxBytes);
}

/** Serializes a raw body: JSON bodies are parsed so keys can be redacted. */
export function serializeBody(body: string, contentType: string | undefined, maxBytes: number, isSecret: KeyMatcher): Capped {
  const looksJson = (contentType ?? '').includes('json') || /^\s*[[{]/.test(body);
  if (looksJson && body.length <= 1024 * 1024) {
    try {
      return serialize(JSON.parse(body), maxBytes, isSecret);
    } catch {
      // fall through to plain text
    }
  }
  return capString(redactText(body, isSecret), maxBytes);
}

/** A JSON literal as far as redaction cares: numbers and booleans as such, anything else as text. */
function literal(text: string): unknown {
  if (text === 'true' || text === 'false') return text === 'true';
  return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) ? Number(text) : text;
}

/** Best-effort redaction for bodies that could not be parsed (e.g. truncated JSON, form bodies). */
export function redactText(text: string, isSecret: KeyMatcher): string {
  return text
    .replace(/"([^"\\]{1,100})"(\s*:\s*)("(?:[^"\\]|\\.)*"?|[^,}\]\s]+)/g, (m, key: string, sep: string, value: string) =>
      isSecret(key, literal(value)) ? `"${key}"${sep}"${REDACTED}"` : m,
    )
    .replace(/(^|&)([^=&\s"{}]{1,100})=([^&]*)/g, (m, pre: string, key: string) =>
      isSecret(key) ? `${pre}${key}=${encodeURIComponent(REDACTED)}` : m,
    );
}

export function redactHeaders(headers: Record<string, unknown> | undefined, isSecret: KeyMatcher): string {
  const out: Record<string, string> = {};
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      out[k.toLowerCase()] = isSecret(k) ? REDACTED : Array.isArray(v) ? v.join(', ') : String(v);
    }
  }
  return JSON.stringify(out);
}

export function redactUrl(url: string, isSecret: KeyMatcher): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const hashIdx = url.indexOf('#', q);
  const query = url.slice(q + 1, hashIdx === -1 ? undefined : hashIdx);
  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    let decoded = key;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      // keep raw key
    }
    return eq !== -1 && isSecret(decoded) ? `${key}=${encodeURIComponent(REDACTED)}` : pair;
  });
  return `${url.slice(0, q)}?${parts.join('&')}`;
}
