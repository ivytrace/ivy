import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appFor, resetTenancyForTests } from './lib/tenancy/testing.js';

beforeEach(() => resetTenancyForTests());

describe('app', () => {
  it('returns config', async () => {
    const res = await (await appFor()).request('/api/config');
    expect(await res.json()).toEqual({ version: '0.1.0', auth: { enabled: false }, workspaces: { multi: false }, email: { enabled: false }, alerts: { slack: false, email: false }, aws: { quick_create: false } });
  });

  it('returns JSON 404 for unknown API paths', async () => {
    const res = await (await appFor()).request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('validates query params before touching ClickHouse', async () => {
    const res = await (await appFor()).request('/api/w/default/p/default/invocations?since=forever');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid since: forever' });
  });

  it('returns 404 for malformed trace IDs, unknown workspaces and unknown projects', async () => {
    const app = await appFor();
    expect((await app.request('/api/w/default/p/default/traces/not-a-trace')).status).toBe(404);
    expect(await (await app.request('/api/w/other/p/default/functions')).json()).toEqual({ error: 'Workspace not found' });
    expect(await (await app.request('/api/w/default/p/nope/functions')).json()).toEqual({ error: 'Project not found' });
  });
});

describe('app with OIDC configured', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requires a token on data routes but not on config', async () => {
    vi.stubEnv('IVY_OIDC_ISSUER', 'https://auth.example.test');
    vi.stubEnv('IVY_OIDC_CLIENT_ID', 'ivy');
    vi.stubEnv('IVY_PUBLIC_URL', 'https://ivy.example.com');
    const app = await appFor();
    expect((await app.request('/api/w/default/p/default/functions')).status).toBe(401);
    expect((await app.request('/api/workspaces')).status).toBe(401);
    expect((await app.request('/api/w/default/aws/template.yaml')).status).toBe(401);
    expect((await app.request('/api/nope')).status).toBe(401);
    const config = await app.request('/api/config');
    expect((await config.json()).auth).toMatchObject({ enabled: true, clientId: 'ivy', audience: 'ivy' });
  });
});
