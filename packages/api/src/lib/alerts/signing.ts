import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Compact signed tokens: `<base64url JSON>.<base64url HMAC-SHA256>`, with the purpose bound into the
 * key, so a token for one use (OAuth state) is never accepted for another (unsubscribe).
 */
const key = (secret: string, purpose: string) =>
  Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), `ivy signed ${purpose}`, 32));

export function sign(payload: Record<string, unknown>, secret: string, purpose: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', key(secret, purpose)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** The payload, or null when the token is malformed, tampered with or (with `exp`, in ms) expired. */
export function verify<T extends Record<string, unknown>>(token: string, secret: string, purpose: string, now = Date.now()): T | null {
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', key(secret, purpose)).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (typeof payload.exp === 'number' && payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
