import { DEFAULT_QUERIES } from '@ivy/spans';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryError, type WorkspaceQuery } from '../../lib/clickhouse/workspace-query.js';
import { defaultQueryId } from '../../lib/query/saved.js';
import { memorySavedQueryStore, setSavedQueryStore } from '../../lib/query/store.js';
import { createProject } from '../../lib/tenancy/projects.js';
import type { ProjectRecord, TenantRecord } from '../../lib/tenancy/store.js';
import { appFor, resetTenancyForTests, testWorkspace } from '../../lib/tenancy/testing.js';

const runs: WorkspaceQuery[] = [];
let answer: () => Promise<unknown> = async () => ({ columns: [], rows: [], truncated: false, stats: { rows_read: 0, bytes_read: 0, elapsed_ms: 1 } });

vi.mock('../../lib/clickhouse/workspace-query.js', async (original) => ({
  ...(await original<typeof import('../../lib/clickhouse/workspace-query.js')>()),
  runWorkspaceQuery: async (q: WorkspaceQuery) => {
    runs.push(q);
    return answer();
  },
}));

let workspace: TenantRecord;
let project: ProjectRecord;

beforeEach(async () => {
  await resetTenancyForTests();
  setSavedQueryStore(memorySavedQueryStore());
  workspace = await testWorkspace('Acme', 'acme');
  project = await createProject(workspace.id, { name: 'Checkout', slug: 'checkout' });
  runs.length = 0;
});

async function call(method: string, path: string, body?: unknown) {
  const app = await appFor(workspace);
  const res = await app.request(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST …/query', () => {
  it('runs in the project, or every project, and the time range asked for', async () => {
    const res = await call('POST', '/api/w/acme/p/checkout/query', { sql: 'SELECT 1', from: '2026-11-14T10:00:00Z', to: '2026-11-14T11:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.range).toEqual({ from: '2026-11-14T10:00:00.000Z', to: '2026-11-14T11:00:00.000Z' });
    expect(runs[0]).toMatchObject({ tenant: { id: workspace.id }, projectId: project.id, sql: 'SELECT 1', maxRows: 1000 });
    await call('POST', '/api/w/acme/query', { sql: 'SELECT 2', since: '1h', limit: 50 });
    expect(runs[1]).toMatchObject({ tenant: { id: workspace.id }, projectId: null, maxRows: 50 });
    expect(runs[1].range.to - runs[1].range.from).toBe(3_600_000);
  });

  it('rejects requests without SQL, with a bad limit or range, and other workspaces', async () => {
    expect((await call('POST', '/api/w/acme/query', {})).status).toBe(400);
    expect((await call('POST', '/api/w/acme/query', { sql: 'SELECT 1', limit: 0 })).status).toBe(400);
    expect((await call('POST', '/api/w/acme/query', { sql: 'SELECT 1', limit: 100_000 })).status).toBe(400);
    expect((await call('POST', '/api/w/acme/query', { sql: 'SELECT 1', since: 'forever' })).status).toBe(400);
    expect((await call('POST', '/api/w/default/query', { sql: 'SELECT 1' })).status).toBe(404);
    expect((await call('POST', '/api/w/acme/p/nope/query', { sql: 'SELECT 1' })).status).toBe(404);
    expect(runs).toHaveLength(0);
  });

  it('answers ClickHouse’s message for bad SQL and limits', async () => {
    answer = async () => {
      throw new QueryError('Unknown expression identifier `nope`');
    };
    expect(await call('POST', '/api/w/acme/query', { sql: 'SELECT nope' })).toEqual({ status: 400, body: { error: 'Unknown expression identifier `nope`' } });
    answer = async () => {
      throw new QueryError('Quota exceeded', 429);
    };
    expect((await call('POST', '/api/w/acme/query', { sql: 'SELECT 1' })).status).toBe(429);
  });
});

describe('saved queries', () => {
  it('start with the defaults, saved once', async () => {
    const first = await call('GET', '/api/w/acme/queries');
    expect(first.body.items.map((q: { name: string }) => q.name)).toEqual(DEFAULT_QUERIES.map((q) => q.name));
    const removed = defaultQueryId(DEFAULT_QUERIES[0].key);
    expect((await call('DELETE', `/api/w/acme/queries/${removed}`)).body).toEqual({ deleted: true });
    const again = await call('GET', '/api/w/acme/queries');
    expect(again.body.items.map((q: { id: string }) => q.id)).not.toContain(removed);
    expect(again.body.items).toHaveLength(DEFAULT_QUERIES.length - 1);
  });

  it('are created, changed and deleted by members', async () => {
    const created = await call('POST', '/api/w/acme/queries', { name: '  Slow checkouts ', sql: 'SELECT * FROM invocations' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Slow checkouts', sql: 'SELECT * FROM invocations', created_by: null });
    const id = created.body.id as string;
    const renamed = await call('PATCH', `/api/w/acme/queries/${id}`, { name: 'Slowest checkouts' });
    expect(renamed.body).toMatchObject({ name: 'Slowest checkouts', sql: 'SELECT * FROM invocations' });
    const list = await call('GET', '/api/w/acme/queries');
    expect(list.body.items.at(-1)).toMatchObject({ id, name: 'Slowest checkouts' });
    await call('DELETE', `/api/w/acme/queries/${id}`);
    expect((await call('PATCH', `/api/w/acme/queries/${id}`, { name: 'x' })).status).toBe(404);
  });

  it('need a name and SQL', async () => {
    expect((await call('POST', '/api/w/acme/queries', { name: '', sql: 'SELECT 1' })).status).toBe(400);
    expect((await call('POST', '/api/w/acme/queries', { name: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/w/acme/queries', { name: 'x'.repeat(101), sql: 'SELECT 1' })).status).toBe(400);
  });
});
