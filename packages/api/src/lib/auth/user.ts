import type { Context } from 'hono';

export interface AuthAgent {
  /** The agent's own client ID, e.g. `agt_ivy_V1StGXR8…`. */
  clientId: string;
  /** The name the agent registered with. Chosen by the agent, not verified. */
  name: string;
}

/** The caller behind a verified access token. */
export interface AuthUser {
  /** Subject at the OIDC provider. Stable; use it to map users to tenants. */
  sub: string;
  issuer: string;
  email?: string;
  /** The provider's `email_verified` claim, when the access token carries it. */
  emailVerified?: boolean;
  name?: string;
  /** Client the token was issued to (the dashboard's client ID, or the agent's). */
  clientId: string;
  /** Set when a coding agent acts for the user. */
  agent: AuthAgent | null;
}

declare module 'hono' {
  interface ContextVariableMap {
    authUser?: AuthUser;
  }
}

/** The authenticated caller, or null when auth is disabled or the route is exempt. */
export function authUser(c: Context): AuthUser | null {
  return c.get('authUser') ?? null;
}
