import type { ClickHouseClient } from '@clickhouse/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { setClientsForTests } from '../../lib/clickhouse/client.js';
import { setMemberListerForTests } from '../../lib/internal/members.js';
import { memoryLimitsStore, setLimitsStore } from '../../lib/limits/store.js';
import { clearUsageCacheForTests } from '../../lib/limits/usage.js';
import { clickhouseTenancyStore, memoryTenancyStore, setTenancyStore } from '../../lib/tenancy/store.js';

const TOKEN = 'internal-token-0123456789abcdefghijklmnop';

let trafficRows: unknown[] = [];
const fake = {
  query: async () => ({ json: async () => trafficRows }),
} as unknown as ClickHouseClient;

const app = createApp({ uiDir: '/nonexistent', tenants: { resolve: async () => ({ id: 'ten_a', shardId: 'shard-1' }) } });

beforeEach(async () => {
  const tenants = memoryTenancyStore();
  await tenants.saveTenant({ id: 'ten_a', name: 'Acme', shard_id: 'shard-1', created_at: 1 });
  await tenants.saveTenant({ id: 'ten_b', name: 'Beta', shard_id: 'shard-1', created_at: 2 });
  setTenancyStore(tenants);
  setLimitsStore(memoryLimitsStore());
  setClientsForTests({ shard: fake, control: fake });
  setMemberListerForTests(async (id) =>
    id === 'ten_a' ? [{ sub: 'idn_owner', email: 'owner@acme.test', role: 'owner' }, { sub: 'idn_dev', email: '', role: 'member' }] : [],
  );
  trafficRows = [];
  clearUsageCacheForTests();
  vi.stubEnv('IVY_INTERNAL_API_TOKEN', TOKEN);
});

afterEach(() => vi.unstubAllEnvs());

afterAll(() => {
  setTenancyStore(clickhouseTenancyStore);
  setClientsForTests(undefined);
  setMemberListerForTests(undefined);
});

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
    expect((await call('PUT', '/internal/workspaces/ten_a/limits', { plan: 'x' }, 'nope')).status).toBe(401);
  });

  it('is not reachable with a user session: /api auth does not apply, and /api has no internal routes', async () => {
    expect((await call('GET', '/api/internal/workspaces', undefined, null)).status).toBe(404);
  });
});

describe('internal API', () => {
  it('limits CRUD: unset by default, PUT, GET, DELETE', async () => {
    const before = await (await call('GET', '/internal/workspaces/ten_a')).json();
    expect(before).toMatchObject({ workspace: 'ten_a', name: 'Acme', traces: 0, blocked: false, limits: { source: 'unset', monthly_trace_quota: null } });

    const put = await call('PUT', '/internal/workspaces/ten_a/limits', { plan: 'Free', monthly_trace_quota: 100_000, over_quota: 'block' });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ workspace: 'ten_a', limits: { plan: 'Free', monthly_trace_quota: 100_000, over_quota: 'block', source: 'workspace' } });

    trafficRows = [{ traces: 100_000 }];
    clearUsageCacheForTests();
    const after = await (await call('GET', '/internal/workspaces/ten_a')).json();
    expect(after).toMatchObject({ traces: 100_000, blocked: true, limits: { plan: 'Free' } });

    const del = await call('DELETE', '/internal/workspaces/ten_a/limits');
    expect(await del.json()).toMatchObject({ limits: { source: 'unset' } });
  });

  it('validates limits and unknown workspaces', async () => {
    expect((await call('PUT', '/internal/workspaces/ten_a/limits', { over_quota: 'drop' })).status).toBe(400);
    expect((await call('PUT', '/internal/workspaces/ten_a/limits')).status).toBe(400);
    expect((await call('PUT', '/internal/workspaces/ten_nope/limits', { plan: 'x' })).status).toBe(404);
    expect((await call('GET', '/internal/workspaces/ten_nope')).status).toBe(404);
    expect((await call('GET', '/internal/workspaces/ten_a?month=2026-13')).status).toBe(400);
  });

  it('lists every workspace with its month usage, or only those without limits', async () => {
    await call('PUT', '/internal/workspaces/ten_b/limits', { plan: 'Pro', monthly_trace_quota: 100_000, over_quota: 'allow' });
    trafficRows = [{ tenant_id: 'ten_b', traces: 250_000 }];
    const list = await (await call('GET', '/internal/workspaces?month=2026-10')).json();
    expect(list.month).toBe('2026-10');
    expect(list.items).toEqual([
      expect.objectContaining({ workspace: 'ten_a', name: 'Acme', traces: 0, limits: expect.objectContaining({ source: 'unset' }) }),
      expect.objectContaining({ workspace: 'ten_b', traces: 250_000, blocked: false, limits: expect.objectContaining({ plan: 'Pro' }) }),
    ]);
    const unset = await (await call('GET', '/internal/workspaces?limits=unset')).json();
    expect(unset.items.map((i: { workspace: string }) => i.workspace)).toEqual(['ten_a']);
  });

  it('lists members with their roles', async () => {
    const res = await (await call('GET', '/internal/workspaces/ten_a/members')).json();
    expect(res).toEqual({
      workspace: 'ten_a',
      items: [
        { sub: 'idn_owner', email: 'owner@acme.test', role: 'owner' },
        { sub: 'idn_dev', email: '', role: 'member' },
      ],
    });
  });
});

describe('GET /api/usage and /api/config', () => {
  it("returns the caller's workspace usage", async () => {
    await call('PUT', '/internal/workspaces/ten_a/limits', { plan: 'Free', monthly_trace_quota: 100, over_quota: 'block' });
    trafficRows = [{ traces: 80 }];
    const res = await app.request('/api/usage');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workspace: 'ten_a', traces: 80, blocked: false, limits: { plan: 'Free', monthly_trace_quota: 100 } });
  });

  it('exposes the billing URL only when IVY_BILLING_URL is set', async () => {
    expect((await (await app.request('/api/config')).json()).billing).toBeUndefined();
    vi.stubEnv('IVY_BILLING_URL', 'https://ivytrace.dev/billing/');
    expect((await (await app.request('/api/config')).json()).billing).toEqual({ url: 'https://ivytrace.dev/billing' });
  });
});
