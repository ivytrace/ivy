export const DEFAULT_SCOPES = 'openid email profile offline_access';

export interface AuthConfig {
  issuer: string;
  clientId: string;
  /** Expected `aud` of access tokens. */
  audience: string;
  scopes: string;
  /** Accept tokens of agents registered under the client (`agt_<clientId>_…`). */
  allowAgents: boolean;
}

/** OIDC settings from the environment, or null when auth is disabled (no issuer configured). */
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | null {
  const issuer = env.IVY_OIDC_ISSUER?.trim().replace(/\/+$/, '');
  if (!issuer) return null;
  const clientId = env.IVY_OIDC_CLIENT_ID?.trim();
  if (!clientId) throw new Error('IVY_OIDC_CLIENT_ID is required when IVY_OIDC_ISSUER is set');
  return {
    issuer,
    clientId,
    audience: env.IVY_OIDC_AUDIENCE?.trim() || clientId,
    scopes: env.IVY_OIDC_SCOPES?.trim() || DEFAULT_SCOPES,
    allowAgents: env.IVY_OIDC_ALLOW_AGENTS !== 'false',
  };
}

/** What `GET /api/config` exposes so the UI can configure itself at runtime. */
export function publicAuthConfig(config: AuthConfig | null) {
  if (!config) return { enabled: false as const };
  const { issuer, clientId, audience, scopes } = config;
  return { enabled: true as const, issuer, clientId, audience, scopes };
}
