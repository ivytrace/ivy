import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { DEFAULT_QUERIES, QUERY_TABLES } from '@ivy/spans';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setClientsForTests } from './client.js';
import { queryStatements, schemaStatements } from './test-schema.js';
import { QueryError, queryUserName, runWorkspaceQuery, setQueryNamesForTests, type WorkspaceQuery } from './workspace-query.js';

/**
 * The Query page's isolation, against a real ClickHouse (the schema's views, role, row policies and profile in a
 * throwaway database):
 *   IVY_TEST_CLICKHOUSE_URL=http://localhost:8123 pnpm --filter @ivy/api test workspace-query
 * The admin user (IVY_CLICKHOUSE_USER / IVY_CLICKHOUSE_PASSWORD, default ivy/ivy) needs access management.
 */
const url = process.env.IVY_TEST_CLICKHOUSE_URL;
const db = `ivy_test_${process.pid}_${Date.now()}`;
const suffix = `${process.pid}${Date.now()}`;
const A = { id: `ten_qa${suffix}`, shardId: 'shard-1' };
const B = { id: `ten_qb${suffix}`, shardId: 'shard-1' };
const T0 = Date.UTC(2026, 10, 14, 10, 0, 0);
const range = { from: T0 - 3_600_000, to: T0 + 3_600_000 };
let admin: ClickHouseClient;

const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

interface SpanInput {
  tenant: string;
  project: string;
  trace: string;
  span: string;
  parent?: string;
  name: string;
  startMs: number;
  durationMs: number;
  attributes?: Record<string, string>;
  logs?: [severity: string, message: string][];
  status?: 'Ok' | 'Error' | 'Unset';
}

function row(s: SpanInput) {
  return {
    TenantId: s.tenant,
    ProjectId: s.project,
    Timestamp: ts(s.startMs),
    TraceId: s.trace,
    SpanId: s.span,
    ParentSpanId: s.parent ?? '',
    SpanName: s.name,
    SpanKind: s.parent ? 'Client' : 'Server',
    ServiceName: 'checkout-api',
    ResourceAttributes: { 'faas.name': 'checkout-api', 'cloud.region': 'eu-west-1' },
    SpanAttributes: s.attributes ?? {},
    Duration: s.durationMs * 1e6,
    StatusCode: s.status ?? 'Unset',
    StatusMessage: '',
    'Events.Timestamp': (s.logs ?? []).map(() => ts(s.startMs + 1)),
    'Events.Name': (s.logs ?? []).map(() => 'log'),
    'Events.Attributes': (s.logs ?? []).map(([severity, message]) => ({ 'log.severity': severity, 'log.message': message })),
  };
}

const invocation = (tenant: string, project: string, trace: string, startMs: number, route: string): SpanInput => ({
  tenant,
  project,
  trace,
  span: trace.slice(0, 16),
  name: 'checkout-api',
  startMs,
  durationMs: 120,
  attributes: { 'ivy.invocation': 'true', 'http.request.method': 'GET', 'url.path': route.replace('{id}', '42'), 'http.route': route },
  logs: [['error', `failed in ${tenant}`]],
});

const ddb = (inv: SpanInput, span: string, count?: number): SpanInput => ({
  tenant: inv.tenant,
  project: inv.project,
  trace: inv.trace,
  span,
  parent: inv.span,
  name: count ? `DynamoDB.GetItem × ${count}` : 'DynamoDB.GetItem',
  startMs: inv.startMs + 5,
  durationMs: 4,
  attributes: { 'rpc.system': 'aws-api', 'rpc.service': 'DynamoDB', 'rpc.method': 'GetItem', ...(count ? { 'ivy.collapsed.count': String(count) } : {}) },
});

const a1 = invocation(A.id, 'prj_a1', 'a'.repeat(32), T0, '/orders/{id}');
const a2 = invocation(A.id, 'prj_a2', 'b'.repeat(32), T0 + 1000, '/carts/{id}');
const aOld = invocation(A.id, 'prj_a1', 'c'.repeat(32), T0 - 86_400_000, '/old');
const b1 = invocation(B.id, 'prj_b1', 'd'.repeat(32), T0, '/secret');

const query = (sql: string, overrides: Partial<WorkspaceQuery> = {}) =>
  runWorkspaceQuery({ tenant: A, projectId: null, range, sql, maxRows: 1000, ...overrides });

async function failure(sql: string): Promise<QueryError> {
  try {
    await query(sql);
  } catch (err) {
    if (err instanceof QueryError) return err;
    throw err;
  }
  throw new Error(`Expected ${sql} to fail`);
}

describe.skipIf(!url)('workspace queries in ClickHouse', () => {
  beforeAll(async () => {
    const credentials = { username: process.env.IVY_CLICKHOUSE_USER ?? 'ivy', password: process.env.IVY_CLICKHOUSE_PASSWORD ?? 'ivy' };
    admin = createClient({ url, ...credentials });
    await admin.command({ query: `CREATE DATABASE ${db}` });
    for (const query of [...schemaStatements(db), ...queryStatements(db)]) await admin.command({ query });
    const spans = [a1, a2, aOld, b1, ddb(a1, '1'.repeat(16)), ddb(a1, '2'.repeat(16), 40), ddb(b1, '3'.repeat(16))];
    await admin.insert({ table: `${db}.otel_traces`, values: spans.map(row), format: 'JSONEachRow' });
    setClientsForTests({ shard: createClient({ url, ...credentials, database: db }) });
    setQueryNamesForTests({ database: `${db}_query`, role: `${db}_query`, profile: `${db}_query` });
  });

  afterAll(async () => {
    if (!admin) return;
    setQueryNamesForTests(undefined);
    setClientsForTests(undefined);
    const name = `${db}_query`;
    for (const q of [
      `DROP USER IF EXISTS ${queryUserName(A.id)}, ${queryUserName(B.id)}`,
      `DROP QUOTA IF EXISTS ${name}`,
      `DROP SETTINGS PROFILE IF EXISTS ${name}`,
      `DROP ROLE IF EXISTS ${name}`,
      `DROP DATABASE IF EXISTS ${name}`,
      `DROP DATABASE IF EXISTS ${db}`,
    ]) {
      await admin.command({ query: q });
    }
    await admin.close();
  });

  it('shows only the workspace’s rows, in the project and time range asked for', async () => {
    const all = await query('SELECT trace_id, http_route FROM invocations ORDER BY trace_id');
    expect(all.columns).toEqual([
      { name: 'trace_id', type: 'String' },
      { name: 'http_route', type: 'String' },
    ]);
    expect(all.rows).toEqual([
      [a1.trace, '/orders/{id}'],
      [a2.trace, '/carts/{id}'],
    ]);
    const one = await query('SELECT trace_id FROM invocations', { projectId: 'prj_a2' });
    expect(one.rows).toEqual([[a2.trace]]);
    const other = await runWorkspaceQuery({ tenant: B, projectId: null, range, sql: 'SELECT trace_id FROM invocations;', maxRows: 10 });
    expect(other.rows).toEqual([[b1.trace]]);
  });

  it('keeps other workspaces out even when the SQL widens its own scope or reads the tables behind the views', async () => {
    const wide = await query(`SELECT count() FROM invocations SETTINGS SQL_ivy_from_ms = '0', SQL_ivy_to_ms = '99999999999999'`);
    expect(wide.rows).toEqual([[3]]);
    const raw = await query(`SELECT DISTINCT TenantId FROM ${db}.otel_traces`);
    expect(raw.rows).toEqual([[A.id]]);
    const merged = await query(`SELECT DISTINCT tenant_id FROM merge('${db}', '^invocations$')`);
    expect(merged.rows).toEqual([[A.id]]);
  });

  it('refuses writes, other settings, higher limits, system tables and table functions', async () => {
    expect((await failure(`SELECT * FROM ${db}.otel_traces SETTINGS SQL_ivy_tenant = '${B.id}'`)).message).toMatch(/readonly/);
    expect((await failure('SELECT 1 SETTINGS readonly = 0')).message).toMatch(/readonly/);
    expect((await failure('SELECT 1 SETTINGS max_execution_time = 3600')).message).toMatch(/shouldn't be greater/);
    expect((await failure(`INSERT INTO ${db}.otel_traces (TraceId) VALUES ('x')`)).message).toMatch(/readonly|privileges/);
    expect((await failure(`DROP TABLE ${db}.invocations`)).message).toMatch(/readonly|privileges/);
    expect((await failure('SELECT * FROM system.users')).message).toMatch(/privileges/);
    expect((await failure(`SELECT * FROM ${db}.invocations_hourly`)).message).toMatch(/privileges/);
    expect((await failure("SELECT * FROM url('http://example.com', 'LineAsString')")).message).toMatch(/privileges/);
    expect((await failure("SELECT * FROM file('x.csv', 'LineAsString')")).message).toMatch(/privileges/);
    expect((await failure("SELECT * FROM remote('localhost', system.one)")).message).toMatch(/privileges/);
  });

  it('turns bad SQL and FORMAT clauses into messages for the user', async () => {
    expect((await failure('SELECT nope FROM invocations')).message).toMatch(/nope/);
    expect((await failure('SELECT 1 FORMAT CSV')).message).toMatch(/Remove the FORMAT clause/);
  });

  it('describes spans and logs with categories, collapsed call counts and log lines', async () => {
    const db_calls = await query(`SELECT trace_id, sum(calls) FROM spans WHERE category = 'database' GROUP BY trace_id`);
    expect(db_calls.rows).toEqual([[a1.trace, 41]]);
    const categories = await query('SELECT DISTINCT category FROM spans ORDER BY category');
    expect(categories.rows).toEqual([['database'], ['invocation']]);
    const logs = await query('SELECT level, message, trace_id FROM logs ORDER BY trace_id');
    expect(logs.rows).toEqual([
      ['error', `failed in ${A.id}`, a1.trace],
      ['error', `failed in ${A.id}`, a2.trace],
    ]);
  });

  it('caps the rows and reports what was read', async () => {
    const result = await query('SELECT * FROM numbers(5000)', { maxRows: 100 });
    expect(result.rows).toHaveLength(100);
    expect(result.truncated).toBe(true);
    const small = await query('SELECT trace_id FROM invocations');
    expect(small.truncated).toBe(false);
    expect(small.stats.rows_read).toBeGreaterThan(0);
  });

  it('has the columns the dashboard and the MCP tool describe, and the default queries run', async () => {
    for (const table of QUERY_TABLES) {
      const result = await query(`SELECT name FROM system.columns WHERE database = '${db}_query' AND table = '${table.name}' ORDER BY position`);
      expect(result.rows.map((r) => r[0]), table.name).toEqual(table.columns.map((c) => c.name));
    }
    for (const q of DEFAULT_QUERIES) await expect(query(q.sql), q.key).resolves.toBeTruthy();
    const routes = await query(DEFAULT_QUERIES.find((q) => q.key === 'slowest-routes')!.sql);
    expect(routes.rows.map((r) => r[1]).sort()).toEqual(['/carts/{id}', '/orders/{id}']);
  });

  it('reads only the workspace’s, project’s and time range’s part of the primary key', async () => {
    for (const table of ['invocations', 'spans', 'logs']) {
      const plan = (await query(`EXPLAIN indexes = 1 SELECT count() FROM ${table}`, { projectId: 'prj_a1' })).rows.map((r) => r[0]).join('\n');
      const primaryKey = plan.slice(plan.indexOf('PrimaryKey'));
      expect(primaryKey, table).toContain(`['${A.id}', '${A.id}']`);
      expect(primaryKey, table).toContain(`['prj_a1', 'prj_a1']`);
      expect(primaryKey, table).toMatch(/\(ts in|toStartOfHour\(Timestamp\) in/);
    }
  });

  it('sets the user up again when its password no longer matches', async () => {
    await query('SELECT 1');
    await admin.command({ query: `ALTER USER ${queryUserName(A.id)} IDENTIFIED WITH sha256_password BY 'changed'` });
    await expect(query('SELECT 1')).resolves.toMatchObject({ rows: [[1]] });
  });
});
