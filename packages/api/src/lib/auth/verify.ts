import { createRemoteJWKSet, errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { type AuthConfig, readAuthConfig } from './config.js';
import type { AuthUser } from './user.js';

const CLOCK_TOLERANCE_S = 30;

export interface VerifyOptions {
  /** Expected `aud`; `IVY_OIDC_AUDIENCE` by default. The MCP endpoint passes its own resource. */
  audience?: string;
  /**
   * Also accept MCP clients registered under this app: any `client_id` (an `mcp_…` ID or a Client ID
   * Metadata Document URL) with `parent_client_id` = the configured client. Only for the MCP audience;
   * `/api` keeps accepting just the dashboard's client and its `agt_` agents.
   */
  mcpClients?: boolean;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public status: 401 | 503,
  ) {
    super(message);
  }
}

interface Discovery {
  issuer: string;
  jwks_uri: string;
}

async function discover(issuer: string): Promise<Discovery> {
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as Partial<Discovery>;
  if (!doc.jwks_uri || !doc.issuer) throw new Error('OIDC discovery document has no issuer or jwks_uri');
  if (doc.issuer.replace(/\/+$/, '') !== issuer) throw new Error(`OIDC discovery issuer ${doc.issuer} does not match ${issuer}`);
  return { issuer: doc.issuer, jwks_uri: doc.jwks_uri };
}

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/**
 * The client a token was issued to. RFC 9068 tokens (Includable Auth) carry `client_id`; most other
 * providers put it in `azp` (Auth0, Keycloak, Entra v2), Okta in `cid`, Entra v1 in `appid`.
 */
const clientOf = (claims: JWTPayload) => str(claims.client_id) ?? str(claims.azp) ?? str(claims.cid) ?? str(claims.appid);

/** Checks that the token belongs to the dashboard's client or, when allowed, to one of its agents. */
export function identify(claims: JWTPayload, config: AuthConfig, issuer: string, options: VerifyOptions = {}): AuthUser {
  const sub = str(claims.sub);
  if (!sub) throw new AuthError('Access token has no subject', 401);
  const client = clientOf(claims);
  const isMcpClient =
    !!options.mcpClients && config.allowAgents && !!client && client !== config.clientId && claims.parent_client_id === config.clientId;
  const isAgent =
    isMcpClient ||
    (config.allowAgents &&
      !!client?.startsWith(`agt_${config.clientId}_`) &&
      (claims.parent_client_id === undefined || claims.parent_client_id === config.clientId));
  if (client !== config.clientId && !isAgent) throw new AuthError('Access token was issued to another client', 401);
  return {
    sub,
    issuer,
    ...(str(claims.email) && { email: str(claims.email) }),
    ...(claims.email_verified !== undefined && { emailVerified: claims.email_verified === true || claims.email_verified === 'true' }),
    ...(str(claims.name) && { name: str(claims.name) }),
    clientId: client!,
    agent: isAgent ? { clientId: client!, name: str(claims.client_name) ?? '' } : null,
  };
}

/**
 * Verifies JWT access tokens against the issuer's JWKS (found through discovery, then cached by jose
 * and refetched when an unknown key ID shows up).
 */
export function createVerifier(config: AuthConfig) {
  let keys: Promise<{ issuer: string; jwks: JWTVerifyGetKey }> | undefined;
  const load = () =>
    (keys ??= discover(config.issuer)
      .then((doc) => ({ issuer: doc.issuer, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) }))
      .catch((error) => {
        keys = undefined;
        throw error;
      }));

  return async function verify(token: string, options: VerifyOptions = {}): Promise<AuthUser> {
    let claims: JWTPayload;
    let issuer: string;
    try {
      const loaded = await load();
      issuer = loaded.issuer;
      ({ payload: claims } = await jwtVerify(token, loaded.jwks, {
        issuer,
        audience: options.audience ?? config.audience,
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ['exp', 'sub'],
      }));
    } catch (error) {
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
        console.error('OIDC: could not load signing keys', error);
        throw new AuthError('Could not reach the identity provider', 503);
      }
      throw new AuthError(error instanceof errors.JWTExpired ? 'Access token expired' : 'Invalid access token', 401);
    }
    return identify(claims, config, issuer, options);
  };
}

let cached: { key: string; verify: ReturnType<typeof createVerifier> } | undefined;

/**
 * Verifies an access token with the configured provider (one verifier, so one JWKS cache, per config).
 * Throws `AuthError`: 401 when invalid, 503 when the provider can't be reached. Check `readAuthConfig()`
 * first: with auth disabled there is nothing to verify against.
 */
export function verifyAccessToken(token: string, options: VerifyOptions & { config?: AuthConfig } = {}): Promise<AuthUser> {
  const config = options.config ?? readAuthConfig();
  if (!config) return Promise.reject(new AuthError('Authentication is not configured', 401));
  const key = JSON.stringify(config);
  if (cached?.key !== key) cached = { key, verify: createVerifier(config) };
  return cached.verify(token, { audience: options.audience, mcpClients: options.mcpClients });
}
