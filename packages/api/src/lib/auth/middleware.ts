import type { MiddlewareHandler } from 'hono';
import { readAuthConfig } from './config.js';
import { AuthError, verifyAccessToken } from './verify.js';

/** API routes that stay public with OIDC on: they carry no user data or authenticate themselves. */
export const PUBLIC_ROUTES = [
  'GET /api/health',
  'GET /api/config',
  // EventBridge API destination, authenticated by the per-connection x-ivy-event-secret header
  'POST /api/aws/events',
  // API description and reference page (docs/implementation/mcp.md)
  'GET /api/openapi.json',
  'GET /api/docs',
];

export const isPublicRoute = (method: string, path: string) =>
  PUBLIC_ROUTES.includes(`${method === 'HEAD' ? 'GET' : method} ${path.replace(/\/+$/, '')}`);

/** The token from an `Authorization: Bearer …` header, or null. */
export const bearerToken = (header: string | undefined) => /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1] ?? null;

/**
 * For `/api/*` only (not `/mcp`, which checks its own audience). Requires a valid bearer access token
 * (audience `IVY_OIDC_AUDIENCE`) on every non-public route when OIDC is configured, and puts the caller on
 * the context (`authUser(c)`). Without OIDC configured, requests pass through unauthenticated.
 */
export function authenticate(): MiddlewareHandler {
  return async (c, next) => {
    const config = readAuthConfig();
    if (!config || c.req.method === 'OPTIONS' || isPublicRoute(c.req.method, c.req.path)) return next();

    const token = bearerToken(c.req.header('authorization'));
    if (!token) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'Authentication required' }, 401);
    }
    try {
      c.set('authUser', await verifyAccessToken(token, { config }));
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      if (error.status === 401) c.header('WWW-Authenticate', `Bearer error="invalid_token", error_description="${error.message}"`);
      return c.json({ error: error.message }, error.status);
    }
    return next();
  };
}
