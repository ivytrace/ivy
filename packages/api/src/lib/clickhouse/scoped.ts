import type { ClickHouseClient } from '@clickhouse/client';

/** Tables whose rows belong to a tenant (`tenant_id`/`TenantId` first in ORDER BY). */
export const TENANT_SCOPED_TABLES = [
  'otel_traces',
  'invocations',
  'invocations_hourly',
  'aws_accounts',
  'aws_functions',
  'aws_function_settings',
  'api_keys',
  'tenant_members',
  'projects',
  'invitations',
  'aws_project_rules',
];

/** Span tables, keyed (tenant, project, …): reads also need a project filter, or an explicit "all projects". */
export const PROJECT_SCOPED_TABLES = ['otel_traces', 'invocations', 'invocations_hourly'];

/** Settings read by the ClickHouse row policies on the data tables (deploy/clickhouse/schema.sql). */
export const TENANT_SETTING = 'SQL_ivy_tenant';
export const PROJECT_SETTING = 'SQL_ivy_project';

const tableRef = (tables: string[]) => new RegExp(`\\b(?:FROM|JOIN)\\s+(?:\\w+\\.)?(${tables.join('|')})\\b`, 'gi');
const TABLE_REF = tableRef(TENANT_SCOPED_TABLES);
const PROJECT_TABLE_REF = tableRef(PROJECT_SCOPED_TABLES);
const TENANT_PARAM = /\{tenant:String\}/g;
const PROJECT_PARAM = /\{project:String\}/g;

export class TenantScopeError extends Error {}

/**
 * What a query may read: one tenant, and for the span tables either one project or, explicitly,
 * every project of the tenant ("all projects of this workspace").
 */
export interface QueryScope {
  tenant: string;
  /** The project the span tables are filtered on. */
  project?: string;
  /** Explicitly every project of the tenant (span tables then need no project filter). */
  allProjects?: boolean;
}

/**
 * Every read of a tenant-scoped table must filter on the bound `{tenant:String}` parameter: at least
 * as many tenant filters as FROM/JOIN references to scoped tables. Reads of the span tables must also
 * filter on `{project:String}` the same way, unless the scope is explicitly all projects.
 */
export function assertTenantScoped(sql: string, params: Record<string, unknown>, options: { allProjects?: boolean } = {}) {
  const refs = [...sql.matchAll(TABLE_REF)].map((m) => m[1]);
  if (!refs.length) return;
  const filters = sql.match(TENANT_PARAM)?.length ?? 0;
  if (filters < refs.length) {
    throw new TenantScopeError(`Query on ${refs.join(', ')} has ${filters} tenant filter(s) for ${refs.length} table reference(s)`);
  }
  if (typeof params.tenant !== 'string' || !params.tenant) throw new TenantScopeError('Query has no tenant bound');
  if (options.allProjects) return;
  const projectRefs = [...sql.matchAll(PROJECT_TABLE_REF)].map((m) => m[1]);
  if (!projectRefs.length) return;
  const projectFilters = sql.match(PROJECT_PARAM)?.length ?? 0;
  if (projectFilters < projectRefs.length) {
    throw new TenantScopeError(
      `Query on ${projectRefs.join(', ')} has ${projectFilters} project filter(s) for ${projectRefs.length} table reference(s); filter on {project:String} or query all projects explicitly`,
    );
  }
  if (typeof params.project !== 'string' || !params.project) throw new TenantScopeError('Query has no project bound');
}

/** `AND <column> = {project:String}` for a project scope, nothing for an all-projects scope. */
export const projectFilter = (scope: QueryScope, column: string) => (scope.allProjects ? '' : `AND ${column} = {project:String}`);

/**
 * Runs a query in a scope: binds `{tenant:String}` (and `{project:String}`), sets the row-policy
 * settings and checks the SQL.
 */
export async function scopedQuery<T>(client: ClickHouseClient, scope: QueryScope, sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
  if (!scope.tenant) throw new TenantScopeError('No tenant');
  if (scope.project !== undefined && !scope.project) throw new TenantScopeError('Empty project');
  const bound = { ...params, tenant: scope.tenant, ...(scope.project ? { project: scope.project } : {}) };
  assertTenantScoped(sql, bound, { allProjects: scope.allProjects === true });
  const result = await client.query({
    query: sql,
    query_params: bound,
    format: 'JSONEachRow',
    clickhouse_settings: { [TENANT_SETTING]: scope.tenant, ...(scope.project ? { [PROJECT_SETTING]: scope.project } : {}) },
  });
  return result.json<T>();
}

/** Runs a query for one tenant (control-plane tables; span tables also need a project, see scopedQuery). */
export function tenantQuery<T>(client: ClickHouseClient, tenant: string, sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
  return scopedQuery<T>(client, { tenant }, sql, params);
}

/**
 * Cross-tenant query (API key lookup, the background sync, the tenant directory). Only allowed in
 * the files listed in scoped.test.ts.
 */
export async function crossTenantQuery<T>(client: ClickHouseClient, sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const result = await client.query({ query: sql, query_params: params, format: 'JSONEachRow' });
  return result.json<T>();
}

/** Inserts rows; rows of tenant-scoped tables must all carry a tenant_id. */
export async function insertRows(client: ClickHouseClient, table: string, values: Record<string, unknown>[]) {
  if (!values.length) return;
  if (TENANT_SCOPED_TABLES.includes(table) && values.some((v) => typeof v.tenant_id !== 'string' || !v.tenant_id)) {
    throw new TenantScopeError(`Insert into ${table} without tenant_id`);
  }
  if (PROJECT_SCOPED_TABLES.includes(table) && values.some((v) => typeof v.project_id !== 'string' || !v.project_id)) {
    throw new TenantScopeError(`Insert into ${table} without project_id`);
  }
  await client.insert({
    table,
    values,
    format: 'JSONEachRow',
    clickhouse_settings: { date_time_input_format: 'best_effort', async_insert: 0 },
  });
}
