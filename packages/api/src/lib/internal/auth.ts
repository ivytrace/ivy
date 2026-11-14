import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const internalApiToken = (env: NodeJS.ProcessEnv = process.env) => env.IVY_INTERNAL_API_TOKEN?.trim() || undefined;

const MIN_TOKEN_LENGTH = 32;

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Guards `/internal/*`: 404 unless IVY_INTERNAL_API_TOKEN is set (so the routes don't exist on a
 * default install), 401 without `Authorization: Bearer <that token>`.
 */
export function internalAuth(): MiddlewareHandler {
  return async (c, next) => {
    const expected = internalApiToken();
    if (!expected) return c.json({ error: 'Not found' }, 404);
    if (expected.length < MIN_TOKEN_LENGTH) {
      console.error(`IVY_INTERNAL_API_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters; the internal API is disabled`);
      return c.json({ error: 'Not found' }, 404);
    }
    const match = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim() ?? '');
    if (!match || !sameToken(match[1].trim(), expected)) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'Invalid internal API token' }, 401);
    }
    await next();
  };
}
