import { mcpRoutes, type TokenVerifier } from '@ivy/mcp';
import type { Hono } from 'hono';
import pkg from '../../../package.json' with { type: 'json' };
import { getApiDocs, getOpenApi } from '../../routes/openapi/get.js';
import { tenantContext, type TenantResolver } from '../tenancy/context.js';
import { mcpAuthFromEnv, rememberMcpUser } from './auth.js';
import { apiData } from './data.js';

/**
 * Ivy's agent-facing surface: the OpenAPI document and docs page (public), and the remote MCP server
 * at /mcp (bearer auth when OIDC is configured, then the same tenant resolution as /api).
 * Called from createApp before the /api tenant middleware.
 */
export function mountAgentSurface(app: Hono, tenants: TenantResolver, verifier?: TokenVerifier) {
  app.get('/api/openapi.json', getOpenApi);
  app.get('/api/docs', getApiDocs);
  app.route(
    '/',
    mcpRoutes({
      auth: mcpAuthFromEnv(verifier),
      onAuthenticated: rememberMcpUser,
      middleware: [tenantContext(tenants)],
      data: apiData,
      version: pkg.version,
    }),
  );
}
