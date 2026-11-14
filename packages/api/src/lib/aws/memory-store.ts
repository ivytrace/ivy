import type { AwsStore } from './store.js';
import type { AwsAccount, FunctionSetting, FunctionStatus, ProjectRule } from './types.js';

/** In-memory AwsStore with the same semantics as the ClickHouse one. Used by tests. */
export function memoryStore() {
  const accounts = new Map<string, AwsAccount>();
  const functions = new Map<string, FunctionStatus>();
  const settings = new Map<string, FunctionSetting & { tenant_id: string }>();
  const rules = new Map<string, ProjectRule>();
  const fnKey = (f: Pick<FunctionStatus, 'tenant_id' | 'account_id' | 'region' | 'function_name'>) =>
    `${f.tenant_id}/${f.account_id}/${f.region}/${f.function_name}`;
  const copy = <T>(v: T): T => structuredClone(v);

  const store: AwsStore = {
    async saveAccount(a) {
      accounts.set(`${a.tenant_id}/${a.id}`, copy(a));
    },
    async deleteAccount(a) {
      accounts.delete(`${a.tenant_id}/${a.id}`);
    },
    async getAccount(tenant, id) {
      const a = accounts.get(`${tenant}/${id}`);
      return a ? copy(a) : null;
    },
    async listAccounts(tenant) {
      return [...accounts.values()].filter((a) => a.tenant_id === tenant).map(copy);
    },
    async listActiveAccounts() {
      return [...accounts.values()].filter((a) => a.status !== 'pending').map(copy);
    },
    async findAccountByEventSecret(secret) {
      const a = [...accounts.values()].find((x) => secret && x.event_secret === secret);
      return a ? copy(a) : null;
    },
    async listFunctions(tenant, accountId) {
      return [...functions.values()].filter((f) => f.tenant_id === tenant && (!accountId || f.account_id === accountId)).map(copy);
    },
    async replaceRegionFunctions(tenant, accountId, region, rows) {
      const seen = new Map<string, number>();
      for (const [k, f] of functions) {
        if (f.tenant_id === tenant && f.account_id === accountId && f.region === region) {
          seen.set(f.function_name, f.first_seen_at);
          functions.delete(k);
        }
      }
      for (const r of rows) functions.set(fnKey(r), copy({ ...r, first_seen_at: seen.get(r.function_name) ?? r.first_seen_at }));
    },
    async saveFunction(row) {
      const existing = functions.get(fnKey(row));
      functions.set(fnKey(row), copy({ ...row, first_seen_at: existing?.first_seen_at ?? row.first_seen_at }));
    },
    async deleteAccountFunctions(tenant, accountId) {
      for (const [k, f] of functions) if (f.tenant_id === tenant && f.account_id === accountId) functions.delete(k);
    },
    async listSettings(tenant, accountId) {
      return [...settings.values()]
        .filter((s) => s.tenant_id === tenant && (!accountId || s.account_id === accountId))
        .map(({ tenant_id: _t, ...s }) => s);
    },
    async saveSetting(tenant, s) {
      settings.set(`${tenant}/${s.account_id}/${s.region}/${s.function_name}`, { tenant_id: tenant, ...s });
    },
    async saveSettings(tenant, list) {
      for (const s of list) await store.saveSetting(tenant, s);
    },
    async listRules(tenant) {
      return [...rules.values()]
        .filter((r) => r.tenant_id === tenant)
        .sort((a, b) => a.position - b.position || a.created_at - b.created_at)
        .map(copy);
    },
    async saveRules(tenant, list, removed = []) {
      for (const id of removed) rules.delete(`${tenant}/${id}`);
      for (const r of list) rules.set(`${tenant}/${r.id}`, copy({ ...r, tenant_id: tenant }));
    },
  };
  return { store, accounts, functions, settings, rules };
}
