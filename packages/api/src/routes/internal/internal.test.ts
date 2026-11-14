import type { ClickHouseClient } from '@clickhouse/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientsForTests } from '../../lib/clickhouse/client.js';
import { memoryLimitsStore, setLimitsStore } from '../../lib/limits/store.js';
import { clearUsageCacheForTests } from '../../lib/limits/usage.js';
import { tenancyStore, type TenantRecord } from '../../lib/tenancy/store.js';
import { appFor, resetTenancyForTests, testWorkspace } from '../../lib/tenancy/testing.js';

const TOKEN = 'internal-token-0123456789abcdefghijklmnop';

let trafficRows: unknown[] = [];
const fake = {
  query: async () => ({ json: async () => trafficRows }),
} as unknown as ClickHouseClient;

let acme: TenantRecord;
let beta: TenantRecord;
let app: Awaited<ReturnType<typeof appFor>>;

beforeEach(async () => {
  await resetTenancyForTests();
  acme = await testWorkspace('Acme', 'acme');
  beta = await testWorkspace('Beta', 'beta');
  await tenancyStore().saveMember({ tenant_id: acme.id, sub: 'idn_owner', email: 'owner@acme.example', role: 'owner', created_at: 1 });
  await tenancyStore().saveMember({ tenant_id: acme.id, sub: 'idn_dev', email: '', role: 'member', created_at: 2 });
  setLimitsStore(memoryLimitsStore());
  setClientsForTests({ shard: fake });
  trafficRows = [];
  clearUsageCacheForTests();
  vi.stubEnv('IVY_INTERNAL_API_TOKEN', TOKEN);
  app = await appFor(acme, 'member');
});

afterEach(() => vi.unstubAllEnvs());

afterAll(() => setClientsForTests(undefined));

const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
  app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('internal API auth', () => {
  it('does not exist without IVY_INTERNAL_API_TOKEN (404, never the SPA)', async () => {
    vi.stubEnv('IVY_INTERNAL_API_TOKEN', '');
    const res = await call('GET', '/internal/workspaces');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('stays off with a token shorter than 32 characters', async () => {
    vi.stubEnv('IVY_INTERNAL_API_TOKEN', 'short');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call('GET', '/internal/workspaces', undefined, 'short')).status).toBe(404);
  });

  it('answers 401 without a token or with a wrong one', async () => {
    expect((await call('GET', '/internal/workspaces', undefined, null)).status).toBe(401);
    const wrong = await call('GET', '/internal/workspaces', undefined, TOKEN.slice(0, -1) + 'X');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe('Bearer');
    expect((await call('PUT', `/internal/workspaces/${acme.id}/limits`, { plan: 'x' }, 'nope')).status).toBe(401);
  });

  it('is not reachable under /api', async () => {
    expect((await call('GET', '/api/internal/workspaces', undefined, null)).status).toBe(404);
  });
});

describe('internal API', () => {
  it('limits CRUD: unset by default, PUT, GET, DELETE', async () => {
    const before = await (await call('GET', `/internal/workspaces/${acme.id}`)).json();
    expect(before).toMatchObject({ workspace: acme.id, name: 'Acme', slug: 'acme', traces: 0, blocked: false, limits: { source: 'unset', monthly_trace_quota: null } });

    const put = await call('PUT', `/internal/workspaces/${acme.id}/limits`, { plan: 'Free', monthly_trace_quota: 50_000, over_quota: 'block' });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ workspace: acme.id, limits: { plan: 'Free', monthly_trace_quota: 50_000, over_quota: 'block', source: 'workspace' } });

    trafficRows = [{ traces: 50_000 }];
    const after = await (await call('GET', `/internal/workspaces/${acme.id}`)).json();
    expect(after).toMatchObject({ traces: 50_000, blocked: true, limits: { plan: 'Free' } });

    const del = await call('DELETE', `/internal/workspaces/${acme.id}/limits`);
    expect(await del.json()).toMatchObject({ limits: { source: 'unset' } });
  });

  it('validates limits and unknown workspaces', async () => {
    expect((await call('PUT', `/internal/workspaces/${acme.id}/limits`, { over_quota: 'drop' })).status).toBe(400);
    expect((await call('PUT', `/internal/workspaces/${acme.id}/limits`)).status).toBe(400);
    expect((await call('PUT', '/internal/workspaces/ten_nope/limits', { plan: 'x' })).status).toBe(404);
    expect((await call('GET', '/internal/workspaces/ten_nope')).status).toBe(404);
    expect((await call('GET', `/internal/workspaces/${acme.id}?month=2026-13`)).status).toBe(400);
  });

  it('lists every workspace with its month usage, or only those without limits', async () => {
    await call('PUT', `/internal/workspaces/${beta.id}/limits`, { plan: 'Pro', monthly_trace_quota: 50_000, over_quota: 'allow' });
    trafficRows = [{ tenant_id: beta.id, traces: 250_000 }];
    const list = await (await call('GET', '/internal/workspaces?month=2026-10')).json();
    expect(list.month).toBe('2026-10');
    expect(list.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspace: acme.id, name: 'Acme', slug: 'acme', traces: 0, limits: expect.objectContaining({ source: 'unset' }) }),
        expect.objectContaining({ workspace: beta.id, traces: 250_000, blocked: false, limits: expect.objectContaining({ plan: 'Pro' }) }),
      ]),
    );
    const unset = await (await call('GET', '/internal/workspaces?limits=unset')).json();
    expect(unset.items.map((i: { workspace: string }) => i.workspace).sort()).toEqual([acme.id, 'default'].sort());
  });

  it('lists members with their roles, from the workspace store', async () => {
    const res = await (await call('GET', `/internal/workspaces/${acme.id}/members`)).json();
    expect(res).toEqual({
      workspace: acme.id,
      items: [
        { sub: 'idn_owner', email: 'owner@acme.example', role: 'owner' },
        { sub: 'idn_dev', email: '', role: 'member' },
      ],
    });
  });
});

describe('workspace usage and /api/config', () => {
  it('GET /api/w/:workspace/usage: any member, all projects, with the limits', async () => {
    await call('PUT', `/internal/workspaces/${acme.id}/limits`, { plan: 'Free', monthly_trace_quota: 100, over_quota: 'block' });
    trafficRows = [{ traces: 80 }];
    const res = await app.request('/api/w/acme/usage');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workspace: acme.id, traces: 80, blocked: false, limits: { plan: 'Free', monthly_trace_quota: 100 } });
    expect((await app.request('/api/w/beta/usage')).status).toBe(404);
  });

  it('exposes the billing URL only when IVY_BILLING_URL is set', async () => {
    expect((await (await app.request('/api/config')).json()).billing).toBeUndefined();
    vi.stubEnv('IVY_BILLING_URL', 'https://ivy.example.com/billing/');
    expect((await (await app.request('/api/config')).json()).billing).toEqual({ url: 'https://ivy.example.com/billing' });
  });
});
