import type { ClickHouseClient } from '@clickhouse/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientsForTests } from '../clickhouse/client.js';
import { PROJECT_SETTING } from '../clickhouse/scoped.js';
import type { TenantRecord } from '../tenancy/store.js';
import { resetTenancyForTests, testWorkspace } from '../tenancy/testing.js';
import { QuotaGate } from './quota-gate.js';
import { loadQuotaSnapshot, upgradeUrl } from './snapshot.js';
import { memoryLimitsStore, setLimitsStore } from './store.js';

let queries: { query: string; query_params: Record<string, unknown>; clickhouse_settings: Record<string, unknown> }[] = [];
const fake = {
  query: async (q: (typeof queries)[number]) => {
    queries.push(q);
    return { json: async () => [{ traces: 100 }] };
  },
} as unknown as ClickHouseClient;

let acme: TenantRecord;

beforeEach(async () => {
  await resetTenancyForTests();
  acme = await testWorkspace('Acme', 'acme');
  setLimitsStore(memoryLimitsStore());
  setClientsForTests({ shard: fake });
  queries = [];
  vi.stubEnv('IVY_PUBLIC_URL', 'https://ivy.example');
});

afterEach(() => vi.unstubAllEnvs());
afterAll(() => setClientsForTests(undefined));

describe('quota snapshot', () => {
  it('without limits: unlimited and no usage query', async () => {
    expect(await loadQuotaSnapshot(acme.id, 'shard-1', '2026-11')).toMatchObject({ used: 0, limits: { source: 'unset' } });
    expect(queries).toEqual([]);
  });

  it("with a blocking quota: the month's traces of all projects, and the workspace's usage page by slug", async () => {
    const { limitsStore } = await import('./store.js');
    await limitsStore().save(acme.id, { plan: 'Free', monthly_trace_quota: 100, over_quota: 'block' });
    const snapshot = await loadQuotaSnapshot(acme.id, 'shard-1', '2026-11');
    expect(snapshot).toMatchObject({ used: 100, upgradeUrl: 'https://ivy.example/w/acme/settings/usage' });
    expect(queries).toHaveLength(1);
    expect(queries[0].query_params).toMatchObject({ tenant: acme.id });
    expect(queries[0].query_params.project).toBeUndefined();
    expect(queries[0].clickhouse_settings[PROJECT_SETTING]).toBeUndefined();

    const gate = new QuotaGate({ load: loadQuotaSnapshot, upgradeUrl: 'https://fallback.example' });
    expect((await gate.check(acme.id, 'shard-1'))?.message).toContain('Upgrade at https://ivy.example/w/acme/settings/usage.');
  });

  it('IVY_UPGRADE_URL wins, with {workspace} filled in', () => {
    vi.stubEnv('IVY_UPGRADE_URL', 'https://billing.example/upgrade?ws={workspace}');
    expect(upgradeUrl('acme')).toBe('https://billing.example/upgrade?ws=acme');
    vi.stubEnv('IVY_UPGRADE_URL', '');
    vi.stubEnv('IVY_PUBLIC_URL', '');
    expect(upgradeUrl('acme')).toBeUndefined();
  });
});
