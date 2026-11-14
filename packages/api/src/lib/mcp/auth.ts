import type { McpAuth, TokenVerifier } from '@ivy/mcp';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readAuthConfig } from '../auth/config.js';
import type { AuthUser } from '../auth/user.js';
import { AuthError, verifyAccessToken } from '../auth/verify.js';

const env = (name: string) => process.env[name]?.trim() || undefined;

/** Canonical MCP URL: IVY_MCP_RESOURCE, else IVY_PUBLIC_URL + /mcp. */
export function mcpResource(): string | null {
  const explicit = env('IVY_MCP_RESOURCE');
  if (explicit) return explicit.replace(/\/$/, '');
  const base = env('IVY_PUBLIC_URL');
  return base ? `${base.replace(/\/$/, '')}/mcp` : null;
}

/** The OIDC verifier (lib/auth) with the MCP audience: null for bad tokens, 503 when the provider is unreachable. */
export const oidcVerifier: TokenVerifier<AuthUser> = {
  async verify(token, { audience }) {
    try {
      return await verifyAccessToken(token, { audience, mcpClients: true });
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) return null;
      if (error instanceof AuthError) throw new HTTPException(error.status, { message: error.message });
      throw error;
    }
  },
};

/** MCP auth settings, or undefined when OIDC is not configured (the endpoint is then open, like the API). */
export function mcpAuthFromEnv(verifier: TokenVerifier<AuthUser> = oidcVerifier): McpAuth<AuthUser> | undefined {
  const config = readAuthConfig();
  if (!config) return undefined;
  const resource = mcpResource();
  if (!resource) throw new Error('IVY_OIDC_ISSUER is set but neither IVY_MCP_RESOURCE nor IVY_PUBLIC_URL is: the MCP endpoint needs its canonical URL');
  return { resource, authorizationServers: [config.issuer], verifier };
}

/** Puts the MCP caller on the context where /api puts its caller (`authUser(c)`). */
export function rememberMcpUser(c: Context, user: AuthUser) {
  c.set('authUser', user);
}
