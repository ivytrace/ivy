import { controlClient } from '../clickhouse/client.js';
import { crossTenantQuery, insertRows, tenantQuery } from '../clickhouse/scoped.js';

export interface TenantRecord {
  id: string;
  name: string;
  shard_id: string;
  created_at: number;
}

export type KeyKind = 'user' | 'auto-trace' | 'bootstrap';

export interface ApiKeyRecord {
  tenant_id: string;
  id: string;
  name: string;
  kind: KeyKind;
  key_hash: string;
  prefix: string;
  /** Only for keys Ivy hands out itself (auto-trace), encrypted with IVY_SECRET_KEY. */
  encrypted_key: string;
  created_at: number;
  revoked_at: number | null;
}

export interface KeyMatch {
  key: ApiKeyRecord;
  tenant: TenantRecord;
}

export type MemberRole = 'owner' | 'member';

/** A signed-in user's access to a tenant, by OIDC subject. */
export interface MemberRecord {
  tenant_id: string;
  sub: string;
  email: string;
  role: MemberRole;
  created_at: number;
}

export interface TenancyStore {
  /** Tenants this OIDC subject belongs to, oldest membership first. */
  findMemberships(sub: string): Promise<MemberRecord[]>;
  saveMember(member: MemberRecord): Promise<void>;
  getTenant(id: string): Promise<TenantRecord | null>;
  listTenants(): Promise<TenantRecord[]>;
  saveTenant(tenant: TenantRecord): Promise<void>;
  listKeys(tenant: string): Promise<ApiKeyRecord[]>;
  saveKey(key: ApiKeyRecord): Promise<void>;
  /** Active (not revoked) key with this hash, with its tenant. */
  findKeyByHash(hash: string): Promise<KeyMatch | null>;
}

const iso = (ms: number) => new Date(ms).toISOString();

let lastVersion = 0;
function version(): string {
  lastVersion = Math.max(Date.now(), lastVersion + 1);
  return iso(lastVersion);
}

const TENANT_COLUMNS = 'id, name, shard_id, toUnixTimestamp64Milli(created_at) AS created_at';
const KEY_COLUMNS = `tenant_id, id, name, kind, key_hash, prefix, encrypted_key,
  toUnixTimestamp64Milli(created_at) AS created_at, toUnixTimestamp64Milli(revoked_at) AS revoked_at`;

const MEMBER_COLUMNS = 'tenant_id, sub, email, role, toUnixTimestamp64Milli(created_at) AS created_at';

export const clickhouseTenancyStore: TenancyStore = {
  // Cross-tenant by nature: it is how a user's tenant is found in the first place.
  findMemberships: (sub) =>
    crossTenantQuery<MemberRecord>(
      controlClient(),
      `SELECT ${MEMBER_COLUMNS} FROM tenant_members FINAL WHERE sub = {sub:String} AND NOT deleted ORDER BY created_at, tenant_id`,
      { sub },
    ),

  saveMember: (m) =>
    insertRows(controlClient(), 'tenant_members', [{ ...m, created_at: iso(m.created_at), updated_at: version(), deleted: 0 }]),

  async getTenant(id) {
    const rows = await crossTenantQuery<TenantRecord>(
      controlClient(),
      `SELECT ${TENANT_COLUMNS} FROM tenants FINAL WHERE id = {id:String} AND NOT deleted`,
      { id },
    );
    return rows[0] ?? null;
  },

  listTenants: () =>
    crossTenantQuery<TenantRecord>(controlClient(), `SELECT ${TENANT_COLUMNS} FROM tenants FINAL WHERE NOT deleted ORDER BY created_at`),

  saveTenant: (t) =>
    insertRows(controlClient(), 'tenants', [{ ...t, created_at: iso(t.created_at), updated_at: version(), deleted: 0 }]),

  listKeys: (tenant) =>
    tenantQuery<ApiKeyRecord>(
      controlClient(),
      tenant,
      `SELECT ${KEY_COLUMNS} FROM api_keys FINAL WHERE tenant_id = {tenant:String} ORDER BY created_at, id`,
    ),

  saveKey: (k) =>
    insertRows(controlClient(), 'api_keys', [
      { ...k, created_at: iso(k.created_at), revoked_at: k.revoked_at === null ? null : iso(k.revoked_at), updated_at: version() },
    ]),

  async findKeyByHash(hash) {
    const keys = await crossTenantQuery<ApiKeyRecord>(
      controlClient(),
      `SELECT ${KEY_COLUMNS} FROM api_keys FINAL WHERE key_hash = {hash:String} AND revoked_at IS NULL LIMIT 1`,
      { hash },
    );
    const key = keys[0];
    if (!key) return null;
    const tenant = await clickhouseTenancyStore.getTenant(key.tenant_id);
    return tenant ? { key, tenant } : null;
  },
};

/** In-memory TenancyStore with the same semantics. Used by tests. */
export function memoryTenancyStore(): TenancyStore {
  const tenants = new Map<string, TenantRecord>();
  const keys = new Map<string, ApiKeyRecord>();
  const members = new Map<string, MemberRecord>();
  const copy = <T>(v: T): T => structuredClone(v);
  return {
    async findMemberships(sub) {
      return [...members.values()]
        .filter((m) => m.sub === sub)
        .sort((a, b) => a.created_at - b.created_at || a.tenant_id.localeCompare(b.tenant_id))
        .map(copy);
    },
    async saveMember(m) {
      members.set(`${m.tenant_id}/${m.sub}`, copy(m));
    },
    async getTenant(id) {
      const t = tenants.get(id);
      return t ? copy(t) : null;
    },
    async listTenants() {
      return [...tenants.values()].map(copy);
    },
    async saveTenant(t) {
      tenants.set(t.id, copy(t));
    },
    async listKeys(tenant) {
      return [...keys.values()].filter((k) => k.tenant_id === tenant).map(copy);
    },
    async saveKey(k) {
      keys.set(`${k.tenant_id}/${k.id}`, copy(k));
    },
    async findKeyByHash(hash) {
      const key = [...keys.values()].find((k) => k.key_hash === hash && k.revoked_at === null);
      const tenant = key && tenants.get(key.tenant_id);
      return key && tenant ? { key: copy(key), tenant: copy(tenant) } : null;
    },
  };
}

let current: TenancyStore = clickhouseTenancyStore;

export const tenancyStore = () => current;

export function setTenancyStore(store: TenancyStore) {
  current = store;
}
