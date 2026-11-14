import { Hono } from 'hono';
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../../routes/config/get.js';
import { authenticate } from './middleware.js';
import { authUser } from './user.js';
import { verifyAccessToken } from './verify.js';

const ISSUER = 'https://auth.example.test';
const CLIENT = 'ivy';
const AUDIENCE = 'https://ivy.example.test/api';

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: { keys: unknown[] };
let fetches = 0;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    fetches++;
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
    }
    if (url === `${ISSUER}/jwks`) return Response.json(jwks);
    return new Response('not found', { status: 404 });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function sign(claims: JWTPayload, options: { key?: CryptoKey; exp?: number | string } = {}) {
  return new SignJWT({ client_id: CLIENT, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'at+jwt' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('idn_123')
    .setIssuedAt()
    .setExpirationTime(options.exp ?? '1h')
    .sign(options.key ?? privateKey);
}

const app = new Hono();
app.use('/api/*', authenticate());
app.get('/api/health', (c) => c.json({ ok: true }));
app.get('/api/config', getConfig);
app.post('/api/aws/events', (c) => c.json({ accepted: true }, 202));
app.get('/api/me', (c) => c.json(authUser(c)));
app.get('/', (c) => c.text('ui'));

const get = (path: string, token?: string) =>
  app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('auth disabled', () => {
  beforeEach(() => vi.stubEnv('IVY_OIDC_ISSUER', ''));

  it('lets every request through without a user', async () => {
    const res = await get('/api/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('reports auth as disabled in /api/config', async () => {
    const res = await get('/api/config');
    expect((await res.json()).auth).toEqual({ enabled: false });
  });
});

describe('auth enabled', () => {
  beforeEach(() => {
    vi.stubEnv('IVY_OIDC_ISSUER', `${ISSUER}/`);
    vi.stubEnv('IVY_OIDC_CLIENT_ID', CLIENT);
    vi.stubEnv('IVY_OIDC_AUDIENCE', AUDIENCE);
    vi.stubEnv('IVY_OIDC_SCOPES', '');
    vi.stubEnv('IVY_OIDC_ALLOW_AGENTS', '');
  });

  it('exposes the public settings in /api/config', async () => {
    const res = await get('/api/config');
    expect((await res.json()).auth).toEqual({
      enabled: true,
      issuer: ISSUER,
      clientId: CLIENT,
      audience: AUDIENCE,
      scopes: 'openid email profile offline_access',
    });
  });

  it('keeps health, config and the events webhook public', async () => {
    expect((await get('/api/health')).status).toBe(200);
    expect((await get('/api/config')).status).toBe(200);
    expect((await app.request('/api/aws/events', { method: 'POST' })).status).toBe(202);
  });

  it('does not touch non-API paths', async () => {
    expect((await get('/')).status).toBe(200);
  });

  it('requires a bearer token', async () => {
    const res = await get('/api/me');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await app.request('/api/me', { headers: { authorization: 'Basic dXNlcjpwYXNz' } })).status).toBe(401);
  });

  it('accepts a valid token and puts the user on the context', async () => {
    const res = await get('/api/me', await sign({ email: 'erin@example.com', name: 'Erin' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sub: 'idn_123',
      issuer: ISSUER,
      email: 'erin@example.com',
      name: 'Erin',
      clientId: CLIENT,
      agent: null,
    });
  });

  it('accepts azp as the client claim', async () => {
    const res = await get('/api/me', await sign({ client_id: undefined, azp: CLIENT }));
    expect(res.status).toBe(200);
  });

  it('refuses an expired token', async () => {
    const res = await get('/api/me', await sign({}, { exp: Math.floor(Date.now() / 1000) - 120 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Access token expired' });
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('allows a little clock skew', async () => {
    const res = await get('/api/me', await sign({}, { exp: Math.floor(Date.now() / 1000) - 5 }));
    expect(res.status).toBe(200);
  });

  it('refuses a token for another audience', async () => {
    const token = await new SignJWT({ client_id: CLIENT })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience('https://other.example.test/api')
      .setSubject('idn_123')
      .setExpirationTime('1h')
      .sign(privateKey);
    expect((await get('/api/me', token)).status).toBe(401);
  });

  it('refuses a token from another issuer', async () => {
    const token = await new SignJWT({ client_id: CLIENT })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://evil.example.test')
      .setAudience(AUDIENCE)
      .setSubject('idn_123')
      .setExpirationTime('1h')
      .sign(privateKey);
    expect((await get('/api/me', token)).status).toBe(401);
  });

  it('refuses a token signed with another key', async () => {
    expect((await get('/api/me', await sign({}, { key: otherKey }))).status).toBe(401);
  });

  it('refuses garbage', async () => {
    expect((await get('/api/me', 'not-a-jwt')).status).toBe(401);
  });

  it('accepts an agent of this client and records which one', async () => {
    const res = await get(
      '/api/me',
      await sign({ client_id: 'agt_ivy_V1StGXR8_Z5jdHi6B-myT', parent_client_id: CLIENT, client_name: 'Claude Code' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sub: 'idn_123',
      clientId: 'agt_ivy_V1StGXR8_Z5jdHi6B-myT',
      agent: { clientId: 'agt_ivy_V1StGXR8_Z5jdHi6B-myT', name: 'Claude Code' },
    });
  });

  it('accepts an agent identified by azp', async () => {
    const res = await get('/api/me', await sign({ client_id: undefined, azp: 'agt_ivy_abc' }));
    expect((await res.json()).agent).toEqual({ clientId: 'agt_ivy_abc', name: '' });
  });

  it('refuses agents when they are turned off', async () => {
    vi.stubEnv('IVY_OIDC_ALLOW_AGENTS', 'false');
    expect((await get('/api/me', await sign({ client_id: 'agt_ivy_abc' }))).status).toBe(401);
  });

  it('refuses an agent of another client', async () => {
    expect((await get('/api/me', await sign({ client_id: 'agt_other_abc' }))).status).toBe(401);
    expect((await get('/api/me', await sign({ client_id: 'agt_ivy_abc', parent_client_id: 'other' }))).status).toBe(401);
  });

  it('refuses tokens issued to unrelated clients', async () => {
    const res = await get('/api/me', await sign({ client_id: 'brandwatcher' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Access token was issued to another client' });
    expect((await get('/api/me', await sign({ client_id: undefined, azp: 'ivy-admin' }))).status).toBe(401);
    expect((await get('/api/me', await sign({ client_id: undefined }))).status).toBe(401);
  });

  it('verifies tokens for another resource with a per-call audience', async () => {
    const MCP = 'https://ivy.example.test/mcp';
    const token = await new SignJWT({ client_id: 'agt_ivy_abc' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(MCP)
      .setSubject('idn_123')
      .setExpirationTime('1h')
      .sign(privateKey);
    expect((await verifyAccessToken(token, { audience: MCP })).agent?.clientId).toBe('agt_ivy_abc');
    expect((await get('/api/me', token)).status).toBe(401);
    await expect(verifyAccessToken(await sign({}), { audience: MCP })).rejects.toThrow('Invalid access token');
  });

  it('caches discovery and keys', async () => {
    const before = fetches;
    await get('/api/me', await sign({}));
    await get('/api/me', await sign({}));
    expect(fetches).toBe(before);
  });
});

describe('identity provider unreachable', () => {
  it('answers 503', async () => {
    vi.stubEnv('IVY_OIDC_ISSUER', 'https://down.example.test');
    vi.stubEnv('IVY_OIDC_CLIENT_ID', CLIENT);
    vi.stubEnv('IVY_OIDC_AUDIENCE', AUDIENCE);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await get('/api/me', await sign({}))).status).toBe(503);
    errors.mockRestore();
  });
});
