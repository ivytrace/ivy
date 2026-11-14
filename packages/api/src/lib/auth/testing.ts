import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { vi } from 'vitest';

const ISSUER = 'https://auth.example.test';
const CLIENT = 'ivy';

export interface TestUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

/**
 * A local OIDC provider for tests: stubs `fetch` for discovery, JWKS and userinfo, sets the OIDC
 * variables (multi-workspace mode) and mints access tokens. `claims` go into the token; `userinfo`
 * is what the userinfo endpoint answers for that token (defaults to the token's claims).
 */
export async function startTestIssuer() {
  const pair = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
  const userinfo = new Map<string, Record<string, unknown>>();
  vi.stubEnv('IVY_OIDC_ISSUER', ISSUER);
  vi.stubEnv('IVY_OIDC_CLIENT_ID', CLIENT);
  vi.stubEnv('IVY_SINGLE_TENANT', '0');
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, userinfo_endpoint: `${ISSUER}/userinfo` });
    }
    if (url === `${ISSUER}/jwks`) return Response.json(jwks);
    if (url === `${ISSUER}/userinfo`) {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      const info = userinfo.get(auth.replace(/^Bearer /, ''));
      return info ? Response.json(info) : new Response('unauthorized', { status: 401 });
    }
    return new Response('not found', { status: 404 });
  });

  async function token(user: TestUser, options: { userinfo?: Record<string, unknown>; claims?: JWTPayload } = {}) {
    const { sub, ...rest } = user;
    const jwt = await new SignJWT({ client_id: CLIENT, ...rest, ...options.claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(pair.privateKey);
    userinfo.set(jwt, options.userinfo ?? { sub, ...rest });
    return jwt;
  }

  return { token, auth: async (user: TestUser, options?: Parameters<typeof token>[1]) => ({ authorization: `Bearer ${await token(user, options)}` }) };
}
