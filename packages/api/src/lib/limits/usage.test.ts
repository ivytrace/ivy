import type { ClickHouseClient } from '@clickhouse/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setClientsForTests } from '../clickhouse/client.js';
import { PROJECT_SETTING, TENANT_SETTING } from '../clickhouse/scoped.js';
import { clearUsageCacheForTests, countMonthlyTraces, countMonthlyTracesAllTenants, currentMonthTraces } from './usage.js';

interface Captured {
  query: string;
  query_params: Record<string, unknown>;
  clickhouse_settings?: Record<string, unknown>;
}

let captured: Captured[] = [];
let rows: unknown[] = [];
const fake = {
  query: async (params: Captured) => {
    captured.push(params);
    return { json: async () => rows };
  },
} as unknown as ClickHouseClient;

beforeEach(() => {
  captured = [];
  rows = [{ traces: 42 }];
  clearUsageCacheForTests();
  setClientsForTests({ shard: fake, control: fake });
});

afterAll(() => setClientsForTests(undefined));

const tenant = { id: 'ten_a', shardId: 'shard-1' };
const NOW = Date.UTC(2026, 10, 14, 12, 30, 15);

describe('monthly trace count', () => {
  it('reads whole hours from the rollup and the partial hours from invocations, for the tenant across all its projects', async () => {
    expect(await countMonthlyTraces(tenant, '2026-11', NOW)).toBe(42);
    const [q] = captured;
    expect(q.query).toMatch(/FROM invocations_hourly/);
    expect(q.query).toMatch(/FROM invocations\s/);
    expect(q.query.match(/\{tenant:String\}/g)).toHaveLength(2);
    expect(q.clickhouse_settings?.[TENANT_SETTING]).toBe('ten_a');
    expect(q.clickhouse_settings?.[PROJECT_SETTING]).toBeUndefined();
    expect(q.query_params.project).toBeUndefined();
    expect(q.query_params).toMatchObject({
      tenant: 'ten_a',
      from: Date.UTC(2026, 10, 1),
      to: NOW,
      h1: Date.UTC(2026, 10, 1),
      h2: Date.UTC(2026, 10, 14, 12),
    });
  });

  it('counts a past month up to its end and a future month as 0 without a query', async () => {
    await countMonthlyTraces(tenant, '2026-10', NOW);
    expect(captured[0].query_params).toMatchObject({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1), h2: Date.UTC(2026, 10, 1) });
    expect(await countMonthlyTraces(tenant, '2026-12', NOW)).toBe(0);
    expect(captured).toHaveLength(1);
  });

  it('caches the current month for a minute', async () => {
    expect(await currentMonthTraces(tenant, NOW)).toBe(42);
    rows = [{ traces: 50 }];
    expect(await currentMonthTraces(tenant, NOW + 30_000)).toBe(42);
    expect(await currentMonthTraces(tenant, NOW + 61_000)).toBe(50);
    expect(captured).toHaveLength(2);
  });

  it('counts every tenant at once, grouped by tenant', async () => {
    rows = [
      { tenant_id: 'ten_a', traces: 5 },
      { tenant_id: 'ten_b', traces: 7 },
    ];
    const all = await countMonthlyTracesAllTenants('2026-11', NOW);
    expect([...all]).toEqual([
      ['ten_a', 5],
      ['ten_b', 7],
    ]);
    expect(captured[0].query).toMatch(/GROUP BY tenant_id\s*$/);
    expect(captured[0].query).not.toMatch(/\{tenant:String\}/);
  });
});
