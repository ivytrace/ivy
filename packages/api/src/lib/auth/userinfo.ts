import { readAuthConfig } from './config.js';
import type { AuthUser } from './user.js';

export interface VerifiedEmail {
  email: string | null;
  verified: boolean;
}

const endpoints = new Map<string, Promise<string | null>>();

async function userinfoEndpoint(issuer: string): Promise<string | null> {
  let pending = endpoints.get(issuer);
  if (!pending) {
    pending = fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) })
      .then(async (res) => (res.ok ? (((await res.json()) as { userinfo_endpoint?: string }).userinfo_endpoint ?? null) : null))
      .catch(() => null);
    pending.then((url) => url ?? endpoints.delete(issuer));
    endpoints.set(issuer, pending);
  }
  return pending;
}

/**
 * The caller's email and whether the identity provider has verified it. Taken from the access
 * token when it has both `email` and `email_verified`; otherwise from the provider's userinfo
 * endpoint, called with the same access token (Includable Auth's access tokens carry no email).
 */
export async function verifiedEmail(user: AuthUser, accessToken: string | null): Promise<VerifiedEmail> {
  if (user.email && user.emailVerified !== undefined) return { email: user.email, verified: user.emailVerified };
  const config = readAuthConfig();
  const url = config && accessToken ? await userinfoEndpoint(config.issuer) : null;
  if (url) {
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const info = (await res.json()) as { sub?: string; email?: unknown; email_verified?: unknown };
        if (info.sub === user.sub && typeof info.email === 'string' && info.email) {
          return { email: info.email, verified: info.email_verified === true || info.email_verified === 'true' };
        }
      }
    } catch {
      // fall back to the token's claims
    }
  }
  return { email: user.email ?? null, verified: user.emailVerified === true };
}

export function clearUserinfoCacheForTests() {
  endpoints.clear();
}
