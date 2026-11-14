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
/** Rows the fake answers a query with (default: none). */
let respond: (q: Captured) => unknown[] = () => [];
const fake = {
  query: async (params: Captured) => {
    captured.push(params);
    return { json: async () => respond(params) };
  },
} as unknown as ClickHouseClient;

let workspace: TenantRecord;
let project: ProjectRecord;
let staging: ProjectRecord;

beforeEach(async () => {
  await resetTenancyForTests();
  workspace = await testWorkspace('Acme', 'acme');
  project = await createProject(workspace.id, { name: 'Checkout (prod)', slug: 'checkout-prod' });
  staging = await createProject(workspace.id, { name: 'Checkout (staging)', slug: 'checkout-staging' });
  captured = [];
  respond = () => [];
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

  it.each(['/invocations', '/invocations?function=f&status=error&q=abc&limit=5', '/stats/timeseries?since=24h', '/stats/timeseries?since=1h&bucket=1m&function=f'])(
    'workspace-wide %s reads all projects of the tenant, explicitly',
    async (route) => {
      const res = await (await appFor(workspace)).request(`/api/w/acme${route}`);
      expect(res.status).toBe(200);
      expect(captured.length).toBeGreaterThan(0);
      for (const q of captured) {
        expect(q.query_params.tenant).toBe(workspace.id);
        expect(q.query).toMatch(/\{tenant:String\}/);
        expect(q.query_params.project).toBeUndefined();
        expect(q.clickhouse_settings[TENANT_SETTING]).toBe(workspace.id);
        expect(q.clickhouse_settings[PROJECT_SETTING]).toBeUndefined();
      }
    },
  );

  it('workspace-wide timeseries narrows to one project with `project` (slug or ID)', async () => {
    const app = await appFor(workspace);
    for (const ref of ['checkout-staging', staging.id]) {
      captured = [];
      const res = await app.request(`/api/w/acme/stats/timeseries?function=f&project=${ref}`);
      expect(res.status).toBe(200);
      expect(captured.length).toBeGreaterThan(0);
      for (const q of captured) {
        expect(q.query_params).toMatchObject({ tenant: workspace.id, project: staging.id, function: 'f' });
        expect(q.clickhouse_settings[PROJECT_SETTING]).toBe(staging.id);
      }
    }
    captured = [];
    expect((await app.request('/api/w/acme/stats/timeseries?function=f&project=nope')).status).toBe(404);
    expect(captured).toEqual([]);
  });

  it("workspace-wide invocations label items with their project and page across projects", async () => {
    const row = (ts: number, span: string, projectId: string) => ({
      project_id: projectId, ts_ms: ts, trace_id: `trace-${span}`, span_id: span, function: 'f', region: 'eu-west-1', status: 'ok',
      duration_ms: 12, cold_start: false, request_id: `req-${span}`, trigger: 'aws:sqs', http_method: '', http_path: '', http_status: 0,
      error_type: '', error_message: '', memory_used_mb: 0, memory_limit_mb: 0, failure_phase: '', synthetic: false, init_duration_ms: 0,
    });
    const t = Date.parse('2026-11-14T12:00:00Z');
    // The query asks for limit + 1 rows to know whether there is a next page.
    respond = (q) => (/FROM invocations/.test(q.query) ? [row(t, 's3', project.id), row(t - 1000, 's2', staging.id), row(t - 2000, 's1', project.id)] : []);
    const app = await appFor(workspace);
    const res = await app.request('/api/w/acme/invocations?since=24h&limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { span_id: string; project_id: string; project: string }[]; next_cursor: string | null };
    expect(body.items.map((i) => [i.span_id, i.project_id, i.project])).toEqual([
      ['s3', project.id, 'checkout-prod'],
      ['s2', staging.id, 'checkout-staging'],
    ]);
    expect(captured[0].query).toMatch(/SELECT project_id,/);
    expect(captured[0].query_params.limit).toBe(3);
    expect(body.next_cursor).toBeTruthy();

    captured = [];
    respond = () => [];
    expect((await app.request(`/api/w/acme/invocations?since=24h&limit=2&cursor=${body.next_cursor}`)).status).toBe(200);
    expect(captured[0].query_params).toMatchObject({ tenant: workspace.id, cursor_ts: t - 1000, cursor_span: 's2' });
    expect(captured[0].query_params.project).toBeUndefined();
  });

  it("project invocations don't carry a project", async () => {
    respond = (q) =>
      /FROM invocations/.test(q.query)
        ? [{ ts_ms: 1, trace_id: 't', span_id: 's', function: 'f', region: 'r', status: 'ok', duration_ms: 1, cold_start: false, request_id: '', trigger: '', http_method: '', http_path: '', http_status: 0, error_type: '', error_message: '', memory_used_mb: 0, memory_limit_mb: 0, failure_phase: '', synthetic: false, init_duration_ms: 0 }]
        : [];
    const res = await (await appFor(workspace)).request('/api/w/acme/p/checkout-prod/invocations');
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items[0]).not.toHaveProperty('project');
    expect(captured[0].query).not.toMatch(/SELECT project_id/);
  });

  it("workspace-wide data of a workspace the caller isn't in is a 404, without queries", async () => {
    const other = await testWorkspace('Other', 'other');
    await createProject(other.id, { name: 'Secret', slug: 'secret' });
    const app = await appFor(workspace);
    for (const route of ['/invocations', '/stats/timeseries', '/stats/timeseries?project=secret', '/functions', '/errors']) {
      expect((await app.request(`/api/w/other${route}`)).status).toBe(404);
      expect((await app.request(`/api/w/${other.id}${route}`)).status).toBe(404);
    }
    expect(captured).toEqual([]);
    // A project of another workspace doesn't resolve inside this one.
    expect((await app.request('/api/w/acme/stats/timeseries?project=secret')).status).toBe(404);
    expect(captured).toEqual([]);
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

  it('has no workspace-wide traces (a trace opens under its project)', async () => {
    const app = await appFor(workspace);
    expect((await app.request('/api/w/acme/traces/673f1a2b0000000000000000000000aa')).status).toBe(404);
    expect(captured).toEqual([]);
  });
});
