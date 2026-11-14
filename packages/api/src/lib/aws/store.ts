import { controlClient } from '../clickhouse/client.js';
import { crossTenantQuery, insertRows, tenantQuery } from '../clickhouse/scoped.js';
import type { AwsAccount, FunctionSetting, FunctionStatus, TraceState } from './types.js';

export interface AwsStore {
  saveAccount(account: AwsAccount): Promise<void>;
  deleteAccount(account: AwsAccount): Promise<void>;
  getAccount(tenant: string, id: string): Promise<AwsAccount | null>;
  listAccounts(tenant: string): Promise<AwsAccount[]>;
  /** Across tenants, for the background sync. */
  listActiveAccounts(): Promise<AwsAccount[]>;
  findAccountByEventSecret(secret: string): Promise<AwsAccount | null>;
  listFunctions(tenant: string, accountId?: string): Promise<FunctionStatus[]>;
  functionCounts(tenant: string): Promise<Map<string, Partial<Record<TraceState, number>>>>;
  /** Upserts `rows` and marks functions of that account/region that are not in `rows` as deleted. */
  replaceRegionFunctions(tenant: string, accountId: string, region: string, rows: FunctionStatus[]): Promise<void>;
  saveFunction(row: FunctionStatus): Promise<void>;
  deleteAccountFunctions(tenant: string, accountId: string): Promise<void>;
  listSettings(tenant: string, accountId: string): Promise<FunctionSetting[]>;
  saveSetting(tenant: string, setting: FunctionSetting): Promise<void>;
}

const iso = (ms: number) => new Date(ms).toISOString();

const ACCOUNT_COLUMNS = `tenant_id, id, name, account_id, role_arn, external_id, event_secret, stack_name, stack_region,
  regions, all_regions, status, error, throttle_metrics, throttle_status,
  toUnixTimestamp64Milli(throttles_polled_to) AS throttles_polled_to,
  toUnixTimestamp64Milli(created_at) AS created_at,
  toUnixTimestamp64Milli(verified_at) AS verified_at,
  toUnixTimestamp64Milli(last_sync_at) AS last_sync_at`;

const FUNCTION_COLUMNS = `tenant_id, account_id, region, function_name, function_arn, runtime, state, reason,
  toUnixTimestamp64Milli(updated_at) AS updated_at`;

/**
 * Updates are full-row inserts into ReplacingMergeTree tables (version = updated_at), read with FINAL.
 * Each write gets a version strictly above the previous one from this process so two writes in the
 * same millisecond still resolve in order.
 */
let lastVersion = 0;
function version(): string {
  lastVersion = Math.max(Date.now(), lastVersion + 1);
  return iso(lastVersion);
}

const insert = (table: string, values: Record<string, unknown>[]) => insertRows(controlClient(), table, values);
const scoped = <T>(tenant: string, sql: string, params: Record<string, unknown> = {}) =>
  tenantQuery<T>(controlClient(), tenant, sql, params);
const crossTenant = <T>(sql: string, params: Record<string, unknown> = {}) => crossTenantQuery<T>(controlClient(), sql, params);

const accountRow = (a: AwsAccount, deleted = 0) => ({
  ...a,
  created_at: iso(a.created_at),
  verified_at: iso(a.verified_at),
  last_sync_at: iso(a.last_sync_at),
  throttles_polled_to: iso(a.throttles_polled_to ?? 0),
  updated_at: version(),
  deleted,
});

const functionRow = (f: FunctionStatus, deleted = 0) => ({ ...f, updated_at: version(), deleted });

export const clickhouseStore: AwsStore = {
  saveAccount: (account) => insert('aws_accounts', [accountRow(account)]),

  deleteAccount: (account) => insert('aws_accounts', [accountRow(account, 1)]),

  async getAccount(tenant, id) {
    const rows = await scoped<AwsAccount>(
      tenant,
      `SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts FINAL
       WHERE tenant_id = {tenant:String} AND id = {id:String} AND NOT deleted`,
      { id },
    );
    return rows[0] ?? null;
  },

  listAccounts: (tenant) =>
    scoped<AwsAccount>(
      tenant,
      `SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts FINAL
       WHERE tenant_id = {tenant:String} AND NOT deleted ORDER BY created_at`,
    ),

  listActiveAccounts: () =>
    crossTenant<AwsAccount>(`SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts FINAL WHERE NOT deleted AND status != 'pending'`),

  async findAccountByEventSecret(secret) {
    if (!secret) return null;
    const rows = await crossTenant<AwsAccount>(
      `SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts FINAL
       WHERE event_secret = {secret:String} AND NOT deleted LIMIT 1`,
      { secret },
    );
    return rows[0] ?? null;
  },

  listFunctions: (tenant, accountId) =>
    scoped<FunctionStatus>(
      tenant,
      `SELECT ${FUNCTION_COLUMNS} FROM aws_functions FINAL
       WHERE tenant_id = {tenant:String} AND NOT deleted
         ${accountId ? 'AND account_id = {accountId:String}' : ''}
       ORDER BY account_id, region, function_name`,
      { accountId: accountId ?? '' },
    ),

  async functionCounts(tenant) {
    const rows = await scoped<{ account_id: string; state: TraceState; n: number }>(
      tenant,
      `SELECT account_id, state, count() AS n FROM aws_functions FINAL
       WHERE tenant_id = {tenant:String} AND NOT deleted GROUP BY account_id, state`,
    );
    const out = new Map<string, Partial<Record<TraceState, number>>>();
    for (const r of rows) out.set(r.account_id, { ...out.get(r.account_id), [r.state]: r.n });
    return out;
  },

  async replaceRegionFunctions(tenant, accountId, region, rows) {
    const existing = await scoped<FunctionStatus>(
      tenant,
      `SELECT ${FUNCTION_COLUMNS} FROM aws_functions FINAL
       WHERE tenant_id = {tenant:String} AND account_id = {accountId:String} AND region = {region:String} AND NOT deleted`,
      { accountId, region },
    );
    const keep = new Set(rows.map((r) => r.function_name));
    const gone = existing.filter((r) => !keep.has(r.function_name));
    await insert('aws_functions', [...rows.map((r) => functionRow(r)), ...gone.map((r) => functionRow(r, 1))]);
  },

  saveFunction: (row) => insert('aws_functions', [functionRow(row)]),

  async deleteAccountFunctions(tenant, accountId) {
    const existing = await clickhouseStore.listFunctions(tenant, accountId);
    await insert('aws_functions', existing.map((r) => functionRow(r, 1)));
  },

  listSettings: (tenant, accountId) =>
    scoped<FunctionSetting>(
      tenant,
      `SELECT account_id, region, function_name, tracing_enabled FROM aws_function_settings FINAL
       WHERE tenant_id = {tenant:String} AND account_id = {accountId:String}`,
      { accountId },
    ),

  saveSetting: (tenant, setting) =>
    insert('aws_function_settings', [{ tenant_id: tenant, ...setting, updated_at: version() }]),
};

let current: AwsStore = clickhouseStore;

export const awsStore = () => current;

export function setAwsStore(store: AwsStore) {
  current = store;
}
