import { controlClient } from '../clickhouse/client.js';
import { crossTenantQuery, insertRows, tenantQuery } from '../clickhouse/scoped.js';
import type { Limits } from './limits.js';

export interface LimitsRecord extends Limits {
  tenant_id: string;
  updated_at: number;
}

export interface LimitsStore {
  get(tenantId: string): Promise<LimitsRecord | null>;
  /** Every workspace that has its own row. */
  list(): Promise<LimitsRecord[]>;
  save(tenantId: string, limits: Limits): Promise<LimitsRecord>;
  /** Drops the workspace's row: it is unlimited again. */
  remove(tenantId: string): Promise<void>;
}

const COLUMNS = 'tenant_id, plan, monthly_trace_quota, over_quota, toUnixTimestamp64Milli(updated_at) AS updated_at';

let lastVersion = 0;
const version = () => (lastVersion = Math.max(Date.now(), lastVersion + 1));

export const clickhouseLimitsStore: LimitsStore = {
  async get(tenantId) {
    const rows = await tenantQuery<LimitsRecord>(
      controlClient(),
      tenantId,
      `SELECT ${COLUMNS} FROM workspace_limits FINAL WHERE tenant_id = {tenant:String} AND NOT deleted`,
    );
    return rows[0] ?? null;
  },

  // Cross-tenant by nature: the internal admin API lists every workspace for billing.
  list: () =>
    crossTenantQuery<LimitsRecord>(controlClient(), `SELECT ${COLUMNS} FROM workspace_limits FINAL WHERE NOT deleted ORDER BY tenant_id`),

  async save(tenantId, limits) {
    const updated_at = version();
    const record: LimitsRecord = { tenant_id: tenantId, ...limits, updated_at };
    await insertRows(controlClient(), 'workspace_limits', [{ ...record, updated_at: new Date(updated_at).toISOString(), deleted: 0 }]);
    return record;
  },

  async remove(tenantId) {
    await insertRows(controlClient(), 'workspace_limits', [
      { tenant_id: tenantId, plan: '', monthly_trace_quota: null, over_quota: 'allow', updated_at: new Date(version()).toISOString(), deleted: 1 },
    ]);
  },
};

/** In-memory LimitsStore with the same semantics. Used by tests. */
export function memoryLimitsStore(): LimitsStore {
  const rows = new Map<string, LimitsRecord>();
  return {
    async get(tenantId) {
      const r = rows.get(tenantId);
      return r ? { ...r } : null;
    },
    async list() {
      return [...rows.values()].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id)).map((r) => ({ ...r }));
    },
    async save(tenantId, limits) {
      const record = { tenant_id: tenantId, ...limits, updated_at: version() };
      rows.set(tenantId, record);
      return { ...record };
    },
    async remove(tenantId) {
      rows.delete(tenantId);
    },
  };
}

let current: LimitsStore = clickhouseLimitsStore;

export const limitsStore = () => current;

export function setLimitsStore(store: LimitsStore) {
  current = store;
}
