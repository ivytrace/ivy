import { controlClient } from '../clickhouse/client.js';
import { crossTenantQuery, insertRows, tenantQuery } from '../clickhouse/scoped.js';
import type { AwsAccount, FunctionSetting, FunctionStatus, ManualMode, ProjectRule } from './types.js';

export interface AwsStore {
  saveAccount(account: AwsAccount): Promise<void>;
  deleteAccount(account: AwsAccount): Promise<void>;
  getAccount(tenant: string, id: string): Promise<AwsAccount | null>;
  listAccounts(tenant: string): Promise<AwsAccount[]>;
  /** Across tenants, for the background sync. */
  listActiveAccounts(): Promise<AwsAccount[]>;
  findAccountByEventSecret(secret: string): Promise<AwsAccount | null>;
  listFunctions(tenant: string, accountId?: string): Promise<FunctionStatus[]>;
  /**
   * Upserts `rows` (keeping each known function's `first_seen_at`) and marks functions of that
   * account/region that are not in `rows` as deleted.
   */
  replaceRegionFunctions(tenant: string, accountId: string, region: string, rows: FunctionStatus[]): Promise<void>;
  saveFunction(row: FunctionStatus): Promise<void>;
  deleteAccountFunctions(tenant: string, accountId: string): Promise<void>;
  listSettings(tenant: string, accountId?: string): Promise<FunctionSetting[]>;
  saveSetting(tenant: string, setting: FunctionSetting): Promise<void>;
  saveSettings(tenant: string, settings: FunctionSetting[]): Promise<void>;
  listRules(tenant: string): Promise<ProjectRule[]>;
  /** Writes the given rules and deletes `removed` (by ID), in one insert. */
  saveRules(tenant: string, rules: ProjectRule[], removed?: string[]): Promise<void>;
}

const iso = (ms: number) => new Date(ms).toISOString();

const ACCOUNT_COLUMNS = `tenant_id, id, name, account_id, role_arn, external_id, event_secret, stack_name, stack_region,
  default_project_id, toUnixTimestamp64Milli(reviewed_at) AS reviewed_at,
  regions, all_regions, status, error, throttle_metrics, throttle_status,
  toUnixTimestamp64Milli(throttles_polled_to) AS throttles_polled_to,
  toUnixTimestamp64Milli(created_at) AS created_at,
  toUnixTimestamp64Milli(verified_at) AS verified_at,
  toUnixTimestamp64Milli(last_sync_at) AS last_sync_at`;

const FUNCTION_COLUMNS = `tenant_id, account_id, region, function_name, function_arn, runtime, state, reason,
  project_id, project_source, rule_id, conflict, wrapper, stack, tags, last_modified,
  toUnixTimestamp64Milli(first_seen_at) AS first_seen_at,
  toUnixTimestamp64Milli(updated_at) AS updated_at`;

const RULE_COLUMNS = `tenant_id, id, position, account_id, region, stack, name, tag, project_id, enabled,
  toUnixTimestamp64Milli(created_at) AS created_at`;

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
const scoped = <T>(tenant: string, sql: string, params: Record<string, unknown> = {}) => tenantQuery<T>(controlClient(), tenant, sql, params);
const crossTenant = <T>(sql: string, params: Record<string, unknown> = {}) => crossTenantQuery<T>(controlClient(), sql, params);

const accountRow = (a: AwsAccount, deleted = 0) => ({
  ...a,
  created_at: iso(a.created_at),
  verified_at: iso(a.verified_at),
  last_sync_at: iso(a.last_sync_at),
  throttles_polled_to: iso(a.throttles_polled_to ?? 0),
  reviewed_at: iso(a.reviewed_at),
  updated_at: version(),
  deleted,
});

const functionRow = (f: FunctionStatus, deleted = 0) => ({ ...f, first_seen_at: iso(f.first_seen_at), updated_at: version(), deleted });

const ruleRow = (r: ProjectRule, deleted = 0) => ({ ...r, created_at: iso(r.created_at), updated_at: version(), deleted });

/** Settings rows from before manual modes only had `tracing_enabled`; false there means exclude. */
const settingMode = (mode: string, tracingEnabled: boolean): ManualMode =>
  mode === 'trace' || mode === 'exclude' ? mode : tracingEnabled ? '' : 'exclude';

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
    scoped<AwsAccount>(tenant, `SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts FINAL WHERE tenant_id = {tenant:String} AND NOT deleted ORDER BY created_at`),

  listActiveAccounts: () => crossTenant<AwsAccount>(`SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts FINAL WHERE NOT deleted AND status != 'pending'`),

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
       ORDER BY account_id, region, stack, function_name`,
      { accountId: accountId ?? '' },
    ),

  async replaceRegionFunctions(tenant, accountId, region, rows) {
    const existing = await scoped<FunctionStatus>(
      tenant,
      `SELECT ${FUNCTION_COLUMNS} FROM aws_functions FINAL
       WHERE tenant_id = {tenant:String} AND account_id = {accountId:String} AND region = {region:String} AND NOT deleted`,
      { accountId, region },
    );
    const seen = new Map(existing.map((r) => [r.function_name, r.first_seen_at]));
    const keep = new Set(rows.map((r) => r.function_name));
    const gone = existing.filter((r) => !keep.has(r.function_name));
    await insert('aws_functions', [
      ...rows.map((r) => functionRow({ ...r, first_seen_at: seen.get(r.function_name) ?? r.first_seen_at })),
      ...gone.map((r) => functionRow(r, 1)),
    ]);
  },

  async saveFunction(row) {
    const [existing] = await scoped<{ first_seen_at: number }>(
      row.tenant_id,
      `SELECT toUnixTimestamp64Milli(first_seen_at) AS first_seen_at FROM aws_functions FINAL
       WHERE tenant_id = {tenant:String} AND account_id = {a:String} AND region = {r:String} AND function_name = {f:String} AND NOT deleted`,
      { a: row.account_id, r: row.region, f: row.function_name },
    );
    await insert('aws_functions', [functionRow({ ...row, first_seen_at: existing?.first_seen_at ?? row.first_seen_at })]);
  },

  async deleteAccountFunctions(tenant, accountId) {
    const existing = await clickhouseStore.listFunctions(tenant, accountId);
    await insert('aws_functions', existing.map((r) => functionRow(r, 1)));
  },

  async listSettings(tenant, accountId) {
    const rows = await scoped<FunctionSetting & { tracing_enabled: boolean }>(
      tenant,
      `SELECT account_id, region, function_name, tracing_enabled, mode, project_id, force FROM aws_function_settings FINAL
       WHERE tenant_id = {tenant:String} ${accountId ? 'AND account_id = {accountId:String}' : ''}`,
      { accountId: accountId ?? '' },
    );
    return rows.map(({ tracing_enabled, ...s }) => ({ ...s, mode: settingMode(s.mode, tracing_enabled) }));
  },

  saveSetting: (tenant, setting) => clickhouseStore.saveSettings(tenant, [setting]),

  saveSettings: (tenant, settings) =>
    insert(
      'aws_function_settings',
      settings.map((s) => ({ tenant_id: tenant, ...s, force: !!s.force, tracing_enabled: s.mode !== 'exclude', updated_at: version() })),
    ),

  listRules: (tenant) =>
    scoped<ProjectRule>(
      tenant,
      `SELECT ${RULE_COLUMNS} FROM aws_project_rules FINAL WHERE tenant_id = {tenant:String} AND NOT deleted ORDER BY position, created_at`,
    ),

  async saveRules(tenant, rules, removed = []) {
    const current = removed.length ? await clickhouseStore.listRules(tenant) : [];
    const gone = current.filter((r) => removed.includes(r.id));
    await insert('aws_project_rules', [...rules.map((r) => ruleRow({ ...r, tenant_id: tenant })), ...gone.map((r) => ruleRow(r, 1))]);
  },
};

let current: AwsStore = clickhouseStore;

export const awsStore = () => current;

export function setAwsStore(store: AwsStore) {
  current = store;
}
