import type { AuthUser, McpAuth, TokenVerifier } from '@ivy/mcp';
import type { Context } from 'hono';

const env = (name: string) => process.env[name]?.trim() || undefined;

/**
 * Placeholder until the OIDC verifier (lib/auth) is merged: rejects every token, so an endpoint with
 * OIDC configured fails closed. See docs/implementation/mcp.md, "Wiring the verifier".
 */
export const pendingVerifier: TokenVerifier = {
  verify: async () => null,
};

/** Canonical MCP URL: IVY_MCP_RESOURCE, else IVY_PUBLIC_URL + /mcp. */
export function mcpResource(): string | null {
  const explicit = env('IVY_MCP_RESOURCE');
  if (explicit) return explicit.replace(/\/$/, '');
  const base = env('IVY_PUBLIC_URL');
  return base ? `${base.replace(/\/$/, '')}/mcp` : null;
}

/** MCP auth settings, or undefined when OIDC is not configured (the endpoint is then open, like the API). */
export function mcpAuthFromEnv(verifier: TokenVerifier = pendingVerifier): McpAuth | undefined {
  const issuer = env('IVY_OIDC_ISSUER');
  if (!issuer) return undefined;
  const resource = mcpResource();
  if (!resource) throw new Error('IVY_OIDC_ISSUER is set but neither IVY_MCP_RESOURCE nor IVY_PUBLIC_URL is: the MCP endpoint needs its canonical URL');
  return { resource, authorizationServers: [issuer], verifier };
}

declare module 'hono' {
  interface ContextVariableMap {
    mcpUser: AuthUser;
  }
}

/** Puts the verified MCP user on the context, where the tenant resolver can read it. */
export function rememberMcpUser(c: Context, user: AuthUser) {
  c.set('mcpUser', user);
}
