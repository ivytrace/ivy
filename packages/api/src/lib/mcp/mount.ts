import { mcpRoutes, type TokenVerifier } from '@ivy/mcp';
import type { Hono } from 'hono';
import pkg from '../../../package.json' with { type: 'json' };
import { getApiDocs, getOpenApi } from '../../routes/openapi/get.js';
import type { AuthUser } from '../auth/user.js';
import type { WorkspaceAccess } from '../tenancy/context.js';
import { mcpAuthFromEnv, rememberMcpUser } from './auth.js';
import { apiData } from './data.js';
import { viewLoader } from './views.js';
import { accessWorkspaces, type WorkspaceSource } from './workspaces.js';

export interface AgentSurfaceOptions {
  /** Built dashboard; the MCP Apps views are read from its `mcp-apps/` folder. */
  uiDir?: string;
  /** Token check for /mcp; the OIDC verifier by default. */
  verifier?: TokenVerifier<AuthUser>;
  /** The caller's workspaces; those `access` lists by default. */
  workspaces?: WorkspaceSource;
}

/**
 * Ivy's agent-facing surface: the OpenAPI document and docs page (public), and the remote MCP server
 * at /mcp (bearer token with the MCP audience when OIDC is configured; reads every workspace the caller
 * is a member of, optionally one project at a time; MCP Apps views from the built UI). Called from
 * createApp with the same WorkspaceAccess as the API.
 */
export function mountAgentSurface(app: Hono, access?: WorkspaceAccess, options: AgentSurfaceOptions = {}) {
  const workspaces = options.workspaces ?? (access ? accessWorkspaces(access) : async () => []);
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
