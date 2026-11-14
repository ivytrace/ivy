import type { ClickHouseClient } from '@clickhouse/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setClientsForTests } from '../lib/clickhouse/client.js';
import { PROJECT_SETTING, TENANT_SETTING } from '../lib/clickhouse/scoped.js';
import { createProject } from '../lib/tenancy/projects.js';
import type { ProjectRecord, TenantRecord } from '../lib/tenancy/store.js';
import { appFor, resetTenancyForTests, testWorkspace } from '../lib/tenancy/testing.js';

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

let workspace: TenantRecord;
let project: ProjectRecord;

beforeEach(async () => {
  await resetTenancyForTests();
  workspace = await testWorkspace('Acme', 'acme');
  project = await createProject(workspace.id, { name: 'Checkout (prod)', slug: 'checkout-prod' });
  await createProject(workspace.id, { name: 'Checkout (staging)', slug: 'checkout-staging' });
  captured = [];
  setClientsForTests({ shard: fake });
});

afterAll(() => setClientsForTests(undefined));

const PROJECT_ROUTES = [
  '/functions?since=7d',
  '/functions?from=2026-11-14T10:20:00Z&to=2026-11-14T14:40:00Z',
  '/invocations',
  '/invocations?function=f&status=error&q=abc&limit=5&cursor=' + Buffer.from(JSON.stringify([1, 'x'])).toString('base64url'),
  '/errors?function=f',
  '/stats/timeseries?since=24h',
  '/stats/timeseries?since=1h&bucket=1m&function=f',
  '/traces/673f1a2b0000000000000000000000aa',
  '/traces/ffffffff0000000000000000000000aa',
];

describe('project scoping of data queries', () => {
  it.each(PROJECT_ROUTES)('%s binds the request tenant and project in every query', async (route) => {
    const app = await appFor(workspace);
    // By slug and by ID.
    for (const ref of ['checkout-prod', project.id]) {
      captured = [];
      const res = await app.request(`/api/w/acme/p/${ref}${route}`);
      expect([200, 404]).toContain(res.status);
      expect(captured.length).toBeGreaterThan(0);
      for (const q of captured) {
        expect(q.query_params).toMatchObject({ tenant: workspace.id, project: project.id });
        expect(q.clickhouse_settings).toMatchObject({ [TENANT_SETTING]: workspace.id, [PROJECT_SETTING]: project.id });
        expect(q.query).toMatch(/\{tenant:String\}/);
        expect(q.query).toMatch(/\{project:String\}/);
      }
    }
  });

  it.each(['/functions?since=7d', '/errors'])('workspace-wide %s reads all projects of the tenant, explicitly', async (route) => {
    const res = await (await appFor(workspace)).request(`/api/w/acme${route}`);
    expect(res.status).toBe(200);
    expect(captured.length).toBeGreaterThan(0);
    for (const q of captured) {
      expect(q.query_params.tenant).toBe(workspace.id);
      expect(q.query_params.project).toBeUndefined();
      expect(q.clickhouse_settings[PROJECT_SETTING]).toBeUndefined();
      expect(q.query).toMatch(/GROUP BY project_id/);
    }
  });

  it('workspace usage counts all projects of the tenant, explicitly', async () => {
    setClientsForTests({ shard: fake, control: fake });
    const res = await (await appFor(workspace)).request('/api/w/acme/usage');
    expect(res.status).toBe(200);
    const spans = captured.filter((q) => /FROM invocations/.test(q.query));
    expect(spans).toHaveLength(1);
    for (const q of captured) {
      expect(q.query_params.tenant).toBe(workspace.id);
      expect(q.query_params.project).toBeUndefined();
      expect(q.clickhouse_settings[PROJECT_SETTING]).toBeUndefined();
    }
  });

  it('scopes the auto-trace config reads to the request tenant', async () => {
    setClientsForTests({ shard: fake, control: fake });
    const app = await appFor(workspace);
    for (const route of ['/aws/accounts', '/aws/functions', '/aws/rules']) await app.request(`/api/w/acme${route}`);
    expect(captured.length).toBeGreaterThan(0);
    for (const q of captured) expect(q.query_params.tenant).toBe(workspace.id);
  });

  it('has no workspace-wide invocations or traces', async () => {
    const app = await appFor(workspace);
    expect((await app.request('/api/w/acme/invocations')).status).toBe(404);
    expect((await app.request('/api/w/acme/traces/673f1a2b0000000000000000000000aa')).status).toBe(404);
    expect(captured).toEqual([]);
  });
});
