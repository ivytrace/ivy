import { controlClient } from '../clickhouse/client.js';
import { crossTenantQuery, insertRows, tenantQuery } from '../clickhouse/scoped.js';
import { workspaceDefaultProject } from './ids.js';

/** A tenant is a workspace: members, AWS accounts, projects, and the shard holding its spans. */
export interface TenantRecord {
  id: string;
  /** Unique across workspaces, used in URLs. `default` for the self-hosted tenant. */
  slug: string;
  name: string;
  shard_id: string;
  /** The workspace's default project; '' (rows from before it existed) means the derived ID, see workspaceDefaultProject. */
  default_project_id?: string;
  created_at: number;
}

export interface ProjectRecord {
  tenant_id: string;
  id: string;
  /** Unique within the workspace, used in URLs. */
  slug: string;
  name: string;
  archived: boolean;
  created_at: number;
}

export type KeyKind = 'user' | 'auto-trace' | 'bootstrap';

export interface ApiKeyRecord {
  tenant_id: string;
  /** '' for keys without a project (from before projects, and the bootstrap key): they follow the workspace's default project. */
  project_id: string;
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
  /** The key's project, or null when it doesn't exist (yet). */
  project: ProjectRecord | null;
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

export interface InvitationRecord {
  tenant_id: string;
  id: string;
  /** Lower-cased. */
  email: string;
  role: MemberRole;
  /** sha256 of the token in the invite link; the token itself is never stored. */
  token_hash: string;
  invited_by: string;
  invited_by_email: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  accepted_by: string;
  revoked_at: number | null;
}

export interface TenancyStore {
  /** Tenants this OIDC subject belongs to, oldest membership first. */
  findMemberships(sub: string): Promise<MemberRecord[]>;
  listMembers(tenant: string): Promise<MemberRecord[]>;
  saveMember(member: MemberRecord): Promise<void>;
  deleteMember(tenant: string, sub: string): Promise<void>;
  getTenant(id: string): Promise<TenantRecord | null>;
  findTenantBySlug(slug: string): Promise<TenantRecord | null>;
  listTenants(): Promise<TenantRecord[]>;
  saveTenant(tenant: TenantRecord): Promise<void>;
  deleteTenant(tenant: TenantRecord): Promise<void>;
  /** All projects of a tenant, archived ones included, oldest first. */
  listProjects(tenant: string): Promise<ProjectRecord[]>;
  saveProject(project: ProjectRecord): Promise<void>;
  listKeys(tenant: string): Promise<ApiKeyRecord[]>;
  saveKey(key: ApiKeyRecord): Promise<void>;
  /** Active (not revoked) key with this hash, with its tenant and project. */
  findKeyByHash(hash: string): Promise<KeyMatch | null>;
  listInvitations(tenant: string): Promise<InvitationRecord[]>;
  saveInvitation(invitation: InvitationRecord): Promise<void>;
  findInvitationByTokenHash(hash: string): Promise<InvitationRecord | null>;
}

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

let lastVersion = 0;
function version(): string {
  lastVersion = Math.max(Date.now(), lastVersion + 1);
  return iso(lastVersion);
}

const TENANT_COLUMNS = 'id, slug, name, shard_id, default_project_id, toUnixTimestamp64Milli(created_at) AS created_at';
const PROJECT_COLUMNS = 'tenant_id, id, slug, name, archived = 1 AS archived, toUnixTimestamp64Milli(created_at) AS created_at';
const KEY_COLUMNS = `tenant_id, project_id, id, name, kind, key_hash, prefix, encrypted_key,
  toUnixTimestamp64Milli(created_at) AS created_at, toUnixTimestamp64Milli(revoked_at) AS revoked_at`;
const MEMBER_COLUMNS = 'tenant_id, sub, email, role, toUnixTimestamp64Milli(created_at) AS created_at';
const INVITATION_COLUMNS = `tenant_id, id, email, role, token_hash, invited_by, invited_by_email,
  toUnixTimestamp64Milli(created_at) AS created_at, toUnixTimestamp64Milli(expires_at) AS expires_at,
  toUnixTimestamp64Milli(accepted_at) AS accepted_at, accepted_by, toUnixTimestamp64Milli(revoked_at) AS revoked_at`;

const control = () => controlClient();
const tenantRow = (t: TenantRecord, deleted = 0) => ({ ...t, created_at: iso(t.created_at), updated_at: version(), deleted });

export const clickhouseTenancyStore: TenancyStore = {
  // Cross-tenant by nature: it is how a user's tenants are found in the first place.
  findMemberships: (sub) =>
    crossTenantQuery<MemberRecord>(
      control(),
      `SELECT ${MEMBER_COLUMNS} FROM tenant_members FINAL WHERE sub = {sub:String} AND NOT deleted ORDER BY created_at, tenant_id`,
      { sub },
    ),
  listMembers: (tenant) =>
    tenantQuery<MemberRecord>(
      control(),
      tenant,
      `SELECT ${MEMBER_COLUMNS} FROM tenant_members FINAL WHERE tenant_id = {tenant:String} AND NOT deleted ORDER BY created_at, sub`,
    ),
  saveMember: (m) => insertRows(control(), 'tenant_members', [{ ...m, created_at: iso(m.created_at), updated_at: version(), deleted: 0 }]),
  deleteMember: (tenant, sub) =>
    insertRows(control(), 'tenant_members', [{ tenant_id: tenant, sub, created_at: iso(0), updated_at: version(), deleted: 1 }]),
  async getTenant(id) {
    const rows = await crossTenantQuery<TenantRecord>(control(), `SELECT ${TENANT_COLUMNS} FROM tenants FINAL WHERE id = {id:String} AND NOT deleted`, {
      id,
    });
    return rows[0] ?? null;
  },
  async findTenantBySlug(slug) {
    const rows = await crossTenantQuery<TenantRecord>(
      control(),
      `SELECT ${TENANT_COLUMNS} FROM tenants FINAL WHERE slug = {slug:String} AND NOT deleted ORDER BY created_at, id LIMIT 1`,
      { slug },
    );
    return rows[0] ?? null;
  },
  listTenants: () => crossTenantQuery<TenantRecord>(control(), `SELECT ${TENANT_COLUMNS} FROM tenants FINAL WHERE NOT deleted ORDER BY created_at`),
  saveTenant: (t) => insertRows(control(), 'tenants', [tenantRow(t)]),
  deleteTenant: (t) => insertRows(control(), 'tenants', [tenantRow(t, 1)]),
  listProjects: (tenant) =>
    tenantQuery<ProjectRecord>(
      control(),
      tenant,
      `SELECT ${PROJECT_COLUMNS} FROM projects FINAL WHERE tenant_id = {tenant:String} ORDER BY created_at, id`,
    ),
  saveProject: (p) =>
    insertRows(control(), 'projects', [{ ...p, archived: p.archived ? 1 : 0, created_at: iso(p.created_at), updated_at: version() }]),
  listKeys: (tenant) =>
    tenantQuery<ApiKeyRecord>(control(), tenant, `SELECT ${KEY_COLUMNS} FROM api_keys FINAL WHERE tenant_id = {tenant:String} ORDER BY created_at, id`),
  saveKey: (k) =>
    insertRows(control(), 'api_keys', [{ ...k, created_at: iso(k.created_at), revoked_at: isoOrNull(k.revoked_at), updated_at: version() }]),
  async findKeyByHash(hash) {
    const keys = await crossTenantQuery<ApiKeyRecord>(
      control(),
      `SELECT ${KEY_COLUMNS} FROM api_keys FINAL WHERE key_hash = {hash:String} AND revoked_at IS NULL LIMIT 1`,
      { hash },
    );
    const key = keys[0];
    if (!key) return null;
    const tenant = await clickhouseTenancyStore.getTenant(key.tenant_id);
    if (!tenant) return null;
    const projectId = key.project_id || workspaceDefaultProject(tenant);
    const projects = await crossTenantQuery<ProjectRecord>(
      control(),
      `SELECT ${PROJECT_COLUMNS} FROM projects FINAL WHERE tenant_id = {tenant_id:String} AND id = {id:String}`,
      { tenant_id: tenant.id, id: projectId },
    );
    return { key, tenant, project: projects[0] ?? null };
  },
  listInvitations: (tenant) =>
    tenantQuery<InvitationRecord>(
      control(),
      tenant,
      `SELECT ${INVITATION_COLUMNS} FROM invitations FINAL WHERE tenant_id = {tenant:String} ORDER BY created_at DESC, id`,
    ),
  saveInvitation: (i) =>
    insertRows(control(), 'invitations', [
      {
        ...i,
        created_at: iso(i.created_at),
        expires_at: iso(i.expires_at),
        accepted_at: isoOrNull(i.accepted_at),
        revoked_at: isoOrNull(i.revoked_at),
        updated_at: version(),
      },
    ]),
  // Cross-tenant: the invite link carries only the token.
  async findInvitationByTokenHash(hash) {
    const rows = await crossTenantQuery<InvitationRecord>(
      control(),
      `SELECT ${INVITATION_COLUMNS} FROM invitations FINAL WHERE token_hash = {hash:String} LIMIT 1`,
      { hash },
    );
    return rows[0] ?? null;
  },
};

/** In-memory TenancyStore with the same semantics. Used by tests. */
export function memoryTenancyStore(): TenancyStore {
  const tenants = new Map<string, TenantRecord>();
  const projects = new Map<string, ProjectRecord>();
  const keys = new Map<string, ApiKeyRecord>();
  const members = new Map<string, MemberRecord>();
  const invitations = new Map<string, InvitationRecord>();
  const copy = <T>(v: T): T => structuredClone(v);
  const byCreated = <T extends { created_at: number }>(a: T, b: T) => a.created_at - b.created_at;
  const store: TenancyStore = {
    async findMemberships(sub) {
      return [...members.values()]
        .filter((m) => m.sub === sub)
        .sort((a, b) => a.created_at - b.created_at || a.tenant_id.localeCompare(b.tenant_id))
        .map(copy);
    },
    async listMembers(tenant) {
      return [...members.values()].filter((m) => m.tenant_id === tenant).sort(byCreated).map(copy);
    },
    async saveMember(m) {
      members.set(`${m.tenant_id}/${m.sub}`, copy(m));
    },
    async deleteMember(tenant, sub) {
      members.delete(`${tenant}/${sub}`);
    },
    async getTenant(id) {
      const t = tenants.get(id);
      return t ? copy(t) : null;
    },
    async findTenantBySlug(slug) {
      const t = [...tenants.values()].sort((a, b) => byCreated(a, b) || a.id.localeCompare(b.id)).find((x) => x.slug === slug);
      return t ? copy(t) : null;
    },
    async listTenants() {
      return [...tenants.values()].map(copy);
    },
    async saveTenant(t) {
      tenants.set(t.id, copy(t));
    },
    async deleteTenant(t) {
      tenants.delete(t.id);
    },
    async listProjects(tenant) {
      return [...projects.values()].filter((p) => p.tenant_id === tenant).sort((a, b) => byCreated(a, b) || a.id.localeCompare(b.id)).map(copy);
    },
    async saveProject(p) {
      projects.set(`${p.tenant_id}/${p.id}`, copy(p));
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
      if (!key || !tenant) return null;
      const project = projects.get(`${tenant.id}/${key.project_id || workspaceDefaultProject(tenant)}`);
      return { key: copy(key), tenant: copy(tenant), project: project ? copy(project) : null };
    },
    async listInvitations(tenant) {
      return [...invitations.values()]
        .filter((i) => i.tenant_id === tenant)
        .sort((a, b) => b.created_at - a.created_at)
        .map(copy);
    },
    async saveInvitation(i) {
      invitations.set(`${i.tenant_id}/${i.id}`, copy(i));
    },
    async findInvitationByTokenHash(hash) {
      const i = [...invitations.values()].find((x) => x.token_hash === hash);
      return i ? copy(i) : null;
    },
  };
  return store;
}

let current: TenancyStore = clickhouseTenancyStore;
export const tenancyStore = () => current;
export function setTenancyStore(store: TenancyStore) {
  current = store;
}
