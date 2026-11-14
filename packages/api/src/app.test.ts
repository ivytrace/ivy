import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

const app = createApp({ uiDir: '/nonexistent', tenants: { resolve: async () => ({ id: 'default', shardId: 'shard-1' }) } });

describe('app', () => {
  it('returns config', async () => {
    const res = await app.request('/api/config');
    expect(await res.json()).toEqual({ version: '0.1.0', auth: { enabled: false } });
  });

  it('returns JSON 404 for unknown API paths', async () => {
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('validates query params before touching ClickHouse', async () => {
    const res = await app.request('/api/invocations?since=forever');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid since: forever' });
  });

  it('returns 404 for malformed trace IDs', async () => {
    const res = await app.request('/api/traces/not-a-trace');
    expect(res.status).toBe(404);
  });
});

describe('app with OIDC configured', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requires a token on data routes but not on config', async () => {
    vi.stubEnv('IVY_OIDC_ISSUER', 'https://auth.example.test');
    vi.stubEnv('IVY_OIDC_CLIENT_ID', 'ivy');
    expect((await app.request('/api/functions')).status).toBe(401);
    expect((await app.request('/api/aws/template.yaml')).status).toBe(401);
    expect((await app.request('/api/nope')).status).toBe(401);
    const config = await app.request('/api/config');
    expect((await config.json()).auth).toMatchObject({ enabled: true, clientId: 'ivy', audience: 'ivy' });
  });
});
