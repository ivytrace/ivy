import { mcpRoutes, type TokenVerifier } from '@ivy/mcp';
import type { Hono } from 'hono';
import pkg from '../../../package.json' with { type: 'json' };
import { getApiDocs, getOpenApi } from '../../routes/openapi/get.js';
import type { AuthUser } from '../auth/user.js';
import type { TenantResolver } from '../tenancy/context.js';
import { mcpAuthFromEnv, rememberMcpUser } from './auth.js';
import { apiData } from './data.js';
import { viewLoader } from './views.js';
import { memberWorkspaces, resolverWorkspaces, type WorkspaceSource } from './workspaces.js';

export interface AgentSurfaceOptions {
  /** Built dashboard; the MCP Apps views are read from its `mcp-apps/` folder. */
  uiDir?: string;
  /** Token check for /mcp; the OIDC verifier by default. */
  verifier?: TokenVerifier<AuthUser>;
  /** The caller's workspaces; all memberships by default. */
  workspaces?: WorkspaceSource;
}

/**
 * Ivy's agent-facing surface: the OpenAPI document and docs page (public), and the remote MCP server
 * at /mcp (bearer token with the MCP audience when OIDC is configured; reads every workspace the caller
 * is a member of; MCP Apps views from the built UI). Called from createApp; `tenants` pins MCP reads to
 * one tenant (tests).
 */
export function mountAgentSurface(app: Hono, tenants?: TenantResolver, options: AgentSurfaceOptions = {}) {
  const workspaces = options.workspaces ?? (tenants ? resolverWorkspaces(tenants) : memberWorkspaces());
  app.get('/api/openapi.json', getOpenApi);
  app.get('/api/docs', getApiDocs);
  app.route(
    '/',
    mcpRoutes({
      auth: mcpAuthFromEnv(options.verifier),
      onAuthenticated: rememberMcpUser,
      data: (c) => apiData(c, workspaces),
      views: options.uiDir ? viewLoader(options.uiDir) : undefined,
      version: pkg.version,
    }),
  );
}
