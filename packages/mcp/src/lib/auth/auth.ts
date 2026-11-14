import type { Context, MiddlewareHandler } from "hono";

export interface AuthUser {
  /** Subject of the token (the user ID at the authorization server). */
  sub: string;
  scopes?: string[];
  clientId?: string;
  [claim: string]: unknown;
}

/**
 * Verifies an access token for one audience. The API wires this to its OIDC verifier; it returns
 * null for any token that is invalid, expired, or not issued for `audience`.
 */
export interface TokenVerifier {
  verify(token: string, options: { audience: string }): Promise<AuthUser | null>;
}

export interface McpAuth {
  /** Canonical URL of the MCP endpoint (`IVY_MCP_RESOURCE`); tokens must carry it as `aud`. */
  resource: string;
  /** Issuers clients may get tokens from (`IVY_OIDC_ISSUER`). */
  authorizationServers: string[];
  verifier: TokenVerifier;
  scopesSupported?: string[];
}

/** RFC 9728 path-suffixed metadata URL for the resource, e.g. https://ivytrace.dev/.well-known/oauth-protected-resource/mcp. */
export function resourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/** The protected resource metadata document (RFC 9728). */
export function protectedResourceMetadata(auth: McpAuth) {
  return {
    resource: auth.resource,
    authorization_servers: auth.authorizationServers,
    bearer_methods_supported: ["header"],
    ...(auth.scopesSupported?.length ? { scopes_supported: auth.scopesSupported } : {}),
    resource_name: "Ivy",
    resource_documentation: new URL("/api/docs", auth.resource).toString(),
  };
}

function unauthorized(c: Context, auth: McpAuth, error?: string) {
  const params = [`resource_metadata="${resourceMetadataUrl(auth.resource)}"`];
  if (error) params.push(`error="invalid_token"`, `error_description="${error}"`);
  c.header("WWW-Authenticate", `Bearer ${params.join(", ")}`);
  return c.json({ error: error ? "invalid_token" : "unauthorized", error_description: error ?? "Bearer token required" }, 401);
}

/**
 * Bearer token check for the MCP endpoint (MCP authorization spec): no or invalid token answers 401
 * with `WWW-Authenticate: Bearer resource_metadata="…"` so clients can discover the authorization server.
 */
export function bearerAuth(auth: McpAuth, onAuthenticated?: (c: Context, user: AuthUser, token: string) => void): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return unauthorized(c, auth);
    const token = match[1].trim();
    const user = await auth.verifier.verify(token, { audience: auth.resource }).catch(() => null);
    if (!user) return unauthorized(c, auth, "The access token is invalid, expired, or not issued for this resource");
    onAuthenticated?.(c, user, token);
    await next();
  };
}
