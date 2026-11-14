import type { ClickHouseClient } from '@clickhouse/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { setClientsForTests } from '../lib/clickhouse/client.js';
import { TENANT_SETTING } from '../lib/clickhouse/scoped.js';

interface Captured {
  query: string;
  query_params: Record<string, unknown>;
  clickhouse_settings: Record<string, unknown>;
}

let captured: Captured[] = [];
const fake = {
  query: async (params: Captured) => {
    captured.push(params);
    return { json: async () => [] };
  },
} as unknown as ClickHouseClient;

const app = createApp({ uiDir: '/nonexistent', tenants: { resolve: async () => ({ id: 'ten_a', shardId: 'shard-1' }) } });

beforeEach(() => {
  captured = [];
  setClientsForTests({ shard: fake, control: fake });
});

afterAll(() => setClientsForTests(undefined));

const DATA_ROUTES = [
  '/api/functions?since=7d',
  '/api/functions?from=2026-11-14T10:20:00Z&to=2026-11-14T14:40:00Z',
  '/api/invocations',
  '/api/invocations?function=f&status=error&q=abc&limit=5&cursor=' + Buffer.from(JSON.stringify([1, 'x'])).toString('base64url'),
  '/api/errors?function=f',
  '/api/stats/timeseries?since=24h',
  '/api/stats/timeseries?since=1h&bucket=1m&function=f',
  '/api/traces/673f1a2b0000000000000000000000aa',
  '/api/traces/ffffffff0000000000000000000000aa',
  '/api/usage',
];

describe('tenant scoping of API queries', () => {
  it.each(DATA_ROUTES)('%s binds the request tenant in every query', async (route) => {
    const res = await app.request(route);
    expect([200, 404]).toContain(res.status);
    expect(captured.length).toBeGreaterThan(0);
    for (const q of captured) {
      expect(q.query_params.tenant).toBe('ten_a');
      expect(q.clickhouse_settings[TENANT_SETTING]).toBe('ten_a');
      expect(q.query).toMatch(/\{tenant:String\}/);
    }
  });

  it('scopes the auto-trace config reads to the request tenant', async () => {
    await app.request('/api/aws/accounts');
    await app.request('/api/aws/functions');
    expect(captured.length).toBeGreaterThan(0);
    for (const q of captured) expect(q.query_params.tenant).toBe('ten_a');
  });
});
