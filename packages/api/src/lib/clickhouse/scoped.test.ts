import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertTenantScoped, projectFilter, TenantScopeError } from './scoped.js';

const SRC = path.resolve(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

describe('assertTenantScoped', () => {
  const both = { tenant: 't', project: 'p' };

  it('accepts queries that filter every scoped table on the tenant (and span tables on the project)', () => {
    expect(() => assertTenantScoped('SELECT 1', {})).not.toThrow();
    expect(() => assertTenantScoped('SELECT * FROM api_keys WHERE tenant_id = {tenant:String}', { tenant: 't' })).not.toThrow();
    expect(() =>
      assertTenantScoped('SELECT * FROM invocations WHERE tenant_id = {tenant:String} AND project_id = {project:String}', both),
    ).not.toThrow();
    expect(() =>
      assertTenantScoped(
        `SELECT * FROM invocations_hourly WHERE tenant_id = {tenant:String} AND project_id = {project:String}
         UNION ALL SELECT * FROM ivy.invocations WHERE tenant_id = {tenant:String} AND project_id = {project:String}`,
        both,
      ),
    ).not.toThrow();
  });

  it('requires a project filter on span tables unless the query is explicitly all projects', () => {
    const sql = 'SELECT * FROM invocations WHERE tenant_id = {tenant:String}';
    expect(() => assertTenantScoped(sql, { tenant: 't' })).toThrow(/project filter/);
    expect(() => assertTenantScoped(sql, both)).toThrow(/project filter/);
    expect(() => assertTenantScoped(sql, { tenant: 't' }, { allProjects: true })).not.toThrow();
    // A project filter without a bound project is no filter.
    expect(() => assertTenantScoped(`${sql} AND project_id = {project:String}`, { tenant: 't' })).toThrow(/no project bound/);
    // One filter for two span-table references isn't enough.
    expect(() =>
      assertTenantScoped(
        `SELECT * FROM invocations_hourly WHERE tenant_id = {tenant:String} AND project_id = {project:String}
         UNION ALL SELECT * FROM invocations WHERE tenant_id = {tenant:String}`,
        both,
      ),
    ).toThrow(/1 project filter\(s\) for 2/);
    // Control tables are not project-scoped.
    expect(() => assertTenantScoped('SELECT * FROM projects FINAL WHERE tenant_id = {tenant:String}', { tenant: 't' })).not.toThrow();
  });

  it('builds the project filter only for a project scope', () => {
    expect(projectFilter({ tenant: 't', project: 'p' }, 'ProjectId')).toBe('AND ProjectId = {project:String}');
    expect(projectFilter({ tenant: 't', allProjects: true }, 'ProjectId')).toBe('');
  });

  it('rejects a scoped table without a tenant filter or without a bound tenant', () => {
    expect(() => assertTenantScoped('SELECT * FROM otel_traces WHERE TraceId = {id:String}', { tenant: 't' })).toThrow(TenantScopeError);
    expect(() => assertTenantScoped('SELECT * FROM aws_accounts FINAL', { tenant: 't' })).toThrow(TenantScopeError);
    expect(() => assertTenantScoped('SELECT * FROM invocations WHERE tenant_id = {tenant:String}', {})).toThrow(TenantScopeError);
  });

  it('needs one tenant filter per scoped table reference', () => {
    const sql = `SELECT * FROM invocations_hourly WHERE tenant_id = {tenant:String}
      UNION ALL SELECT * FROM invocations WHERE ts > 0`;
    expect(() => assertTenantScoped(sql, { tenant: 't' })).toThrow(/1 tenant filter\(s\) for 2/);
    expect(() =>
      assertTenantScoped('SELECT * FROM invocations AS a JOIN otel_traces AS b ON a.trace_id = b.TraceId WHERE a.tenant_id = {tenant:String}', {
        tenant: 't',
      }),
    ).toThrow(TenantScopeError);
  });
});

describe('ClickHouse access in the API source', () => {
  const files = sourceFiles(SRC);

  it('goes through the scoped helpers: no raw client calls outside lib/clickhouse', () => {
    const offenders = files
      .filter((f) => !rel(f).startsWith('lib/clickhouse/'))
      .filter((f) => /\.(query|insert|command|exec)\(\s*\{/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('only uses crossTenantQuery in the reviewed places', () => {
    const users = files.filter((f) => /crossTenantQuery\s*[<(]/.test(readFileSync(f, 'utf8'))).map(rel).sort();
    // Each of these is reviewed: API key lookup and the tenant directory (tenancy/store), the
    // background sync and EventBridge secret lookup (aws/store), the internal API's list of every
    // workspace's limits and monthly traces for billing (limits/store, limits/usage), the alert
    // evaluator's list of connected Slack channels and the job leases (alerts/store).
    expect(users).toEqual(['lib/alerts/store.ts', 'lib/aws/store.ts', 'lib/clickhouse/scoped.ts', 'lib/limits/store.ts', 'lib/limits/usage.ts', 'lib/tenancy/store.ts']);
  });
});
