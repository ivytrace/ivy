export const REDACTED = '[redacted]';

const normalize = (key: string) => key.toLowerCase().replace(/[-_]/g, '');

export type KeyMatcher = (key: string) => boolean;

export function createKeyMatcher(keys: string[]): KeyMatcher {
  const needles = [...new Set(keys.map(normalize).filter(Boolean))];
  const cache = new Map<string, boolean>();
  return (key: string) => {
    let hit = cache.get(key);
    if (hit === undefined) {
      const k = normalize(key);
      hit = needles.some((n) => k.includes(n));
      if (cache.size < 5000) cache.set(key, hit);
    }
    return hit;
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
      if (key !== '' && isSecret(key)) return REDACTED;
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

/** Best-effort redaction for bodies that could not be parsed (e.g. truncated JSON, form bodies). */
export function redactText(text: string, isSecret: KeyMatcher): string {
  return text
    .replace(/"([^"\\]{1,100})"(\s*:\s*)("(?:[^"\\]|\\.)*"?|[^,}\]\s]+)/g, (m, key: string, sep: string) =>
      isSecret(key) ? `"${key}"${sep}"${REDACTED}"` : m,
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
