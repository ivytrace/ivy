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
  'workspace_limits',
];

/** Setting read by the ClickHouse row policies on the data tables (deploy/clickhouse/schema.sql). */
export const TENANT_SETTING = 'SQL_ivy_tenant';

const TABLE_REF = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:\\w+\\.)?(${TENANT_SCOPED_TABLES.join('|')})\\b`, 'gi');
const TENANT_PARAM = /\{tenant:String\}/g;

export class TenantScopeError extends Error {}

/**
 * Every read of a tenant-scoped table must filter on the bound `{tenant:String}` parameter:
 * at least as many tenant filters as FROM/JOIN references to scoped tables.
 */
export function assertTenantScoped(sql: string, params: Record<string, unknown>) {
  const refs = [...sql.matchAll(TABLE_REF)].map((m) => m[1]);
  if (!refs.length) return;
  const filters = sql.match(TENANT_PARAM)?.length ?? 0;
  if (filters < refs.length) {
    throw new TenantScopeError(`Query on ${refs.join(', ')} has ${filters} tenant filter(s) for ${refs.length} table reference(s)`);
  }
  if (typeof params.tenant !== 'string' || !params.tenant) throw new TenantScopeError('Query has no tenant bound');
}

/** Runs a query for one tenant: binds `{tenant:String}`, sets the row-policy setting and checks the SQL. */
export async function tenantQuery<T>(
  client: ClickHouseClient,
  tenant: string,
  sql: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  if (!tenant) throw new TenantScopeError('No tenant');
  const bound = { ...params, tenant };
  assertTenantScoped(sql, bound);
  const result = await client.query({
    query: sql,
    query_params: bound,
    format: 'JSONEachRow',
    clickhouse_settings: { [TENANT_SETTING]: tenant },
  });
  return result.json<T>();
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
  await client.insert({
    table,
    values,
    format: 'JSONEachRow',
    clickhouse_settings: { date_time_input_format: 'best_effort', async_insert: 0 },
  });
}
