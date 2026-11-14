import { derivedProjectId, hashKey, keyPrefix, newApiKey, newKeyId, newTenantId } from './ids.js';
import { decrypt, encrypt, serverSecret } from './secret-box.js';
import { DEFAULT_SHARD, shardConfigs } from './shards.js';
import { claimSlug, slugify } from './slugs.js';
import { tenancyStore, type ApiKeyRecord, type KeyKind, type ProjectRecord, type TenantRecord } from './store.js';

export const DEFAULT_TENANT = 'default';
export const BOOTSTRAP_PROJECT_SLUG = 'default';

/**
 * Gives a workspace the first free slug of `base`, `base-2`, … (unique across workspaces, see
 * claimSlug), writing the tenant row with it.
 */
export function claimWorkspaceSlug(tenant: TenantRecord, base: string): Promise<string> {
  const store = tenancyStore();
  return claimSlug({
    scope: 'workspace',
    base,
    taken: async (slug) => {
      if (slug === DEFAULT_TENANT) return true;
      const owner = await store.findTenantBySlug(slug);
      return !!owner && owner.id !== tenant.id;
    },
    write: (slug) => store.saveTenant({ ...tenant, slug }),
    won: async (slug) => (await store.findTenantBySlug(slug))?.id === tenant.id,
  });
}

/** The self-hosted "Default" project the bootstrap key is created in: an ordinary project with a derived ID. */
export async function ensureBootstrapProject(): Promise<ProjectRecord> {
  const store = tenancyStore();
  const id = derivedProjectId(DEFAULT_TENANT);
  const projects = await store.listProjects(DEFAULT_TENANT);
  const existing = projects.find((p) => p.id === id);
  if (existing) return existing;
  const slug = projects.some((p) => p.slug === BOOTSTRAP_PROJECT_SLUG) ? `${BOOTSTRAP_PROJECT_SLUG}-${id.slice(4, 8)}` : BOOTSTRAP_PROJECT_SLUG;
  const project: ProjectRecord = { tenant_id: DEFAULT_TENANT, id, slug, name: 'Default', archived: false, created_at: Date.now() };
  await store.saveProject(project);
  return project;
}

/**
 * Creates a tenant (workspace), without projects: the first one comes from the welcome wizard. `slug`
 * is used as given (the caller checked it); otherwise one is generated from `slugBase` (default: the name).
 */
export async function createTenant(name: string, shardId = DEFAULT_SHARD, id = newTenantId(), slug?: string, slugBase?: string): Promise<TenantRecord> {
  if (!shardConfigs().has(shardId)) throw new Error(`Unknown shard ${shardId}`);
  const tenant: TenantRecord = { id, slug: slug ?? (id === DEFAULT_TENANT ? DEFAULT_TENANT : ''), name, shard_id: shardId, created_at: Date.now() };
  if (tenant.slug) await tenancyStore().saveTenant(tenant);
  else tenant.slug = await claimWorkspaceSlug(tenant, slugify(slugBase ?? name));
  return tenant;
}

export async function setTenantShard(id: string, shardId: string): Promise<TenantRecord> {
  if (!shardConfigs().has(shardId)) throw new Error(`Unknown shard ${shardId}`);
  const tenant = await tenancyStore().getTenant(id);
  if (!tenant) throw new Error(`Unknown tenant ${id}`);
  const next = { ...tenant, shard_id: shardId };
  await tenancyStore().saveTenant(next);
  return next;
}

function keyRecord(tenantId: string, projectId: string, key: string, name: string, kind: KeyKind, id = newKeyId()): ApiKeyRecord {
  return {
    tenant_id: tenantId,
    project_id: projectId,
    id,
    name,
    kind,
    key_hash: hashKey(key),
    prefix: keyPrefix(key),
    encrypted_key: '',
    created_at: Date.now(),
    revoked_at: null,
  };
}

/** Mints an ingest key for a project. The plaintext is returned once and only its hash is stored. */
export async function createApiKey(tenantId: string, projectId: string, name: string): Promise<{ key: string; record: ApiKeyRecord }> {
  if (!(await tenancyStore().getTenant(tenantId))) throw new Error(`Unknown tenant ${tenantId}`);
  const project = (await tenancyStore().listProjects(tenantId)).find((p) => p.id === projectId);
  if (!project) throw new Error(`Unknown project ${projectId} in tenant ${tenantId}`);
  if (project.archived) throw new Error(`Project ${project.slug} is archived`);
  const key = newApiKey();
  const record = keyRecord(tenantId, projectId, key, name, 'user');
  await tenancyStore().saveKey(record);
  return { key, record };
}

export async function revokeApiKey(tenantId: string, keyId: string): Promise<ApiKeyRecord> {
  const record = (await tenancyStore().listKeys(tenantId)).find((k) => k.id === keyId);
  if (!record) throw new Error(`Unknown key ${keyId} for tenant ${tenantId}`);
  const revoked = { ...record, revoked_at: record.revoked_at ?? Date.now() };
  await tenancyStore().saveKey(revoked);
  if (record.kind !== 'user') autoTraceKeys.delete(`${tenantId}/${record.project_id}`);
  return revoked;
}

/**
 * Gives every key without a project (keys from before projects, and bootstrap keys, which used to
 * follow the workspace's default project) the project it was sending to: the workspace's former
 * default project (`tenants.default_project_id`, '' meaning the derived ID). Written explicitly, so
 * nothing resolves a fallback any more. Idempotent; the API and the ingest router run it on startup.
 */
export async function assignProjectlessKeys(): Promise<number> {
  const store = tenancyStore();
  const tenants = new Map<string, Promise<TenantRecord | null>>();
  let assigned = 0;
  for (const key of await store.listKeysWithoutProject()) {
    if (!tenants.has(key.tenant_id)) tenants.set(key.tenant_id, store.getTenant(key.tenant_id));
    const tenant = await tenants.get(key.tenant_id);
    if (!tenant) continue;
    await store.saveKey({ ...key, project_id: tenant.default_project_id || derivedProjectId(tenant.id) });
    assigned++;
  }
  return assigned;
}

/**
 * Self-hosted bootstrap: the `default` tenant always exists, and IVY_INGEST_API_KEY (when set) is a
 * key of an ordinary project, created as "Default" (see ensureBootstrapProject) the first time. A new
 * value of the variable revokes the previous bootstrap key and takes over its project while that is
 * active. The key ID is derived from the hash, so concurrent or repeated runs write the same row.
 * Unsetting the variable revokes nothing (use the tenants CLI).
 */
export async function ensureDefaultTenant(envKey = process.env.IVY_INGEST_API_KEY?.trim()): Promise<void> {
  const store = tenancyStore();
  if (!(await store.getTenant(DEFAULT_TENANT))) await createTenant('Default', DEFAULT_SHARD, DEFAULT_TENANT);
  if (!envKey) return;
  const keys = await store.listKeys(DEFAULT_TENANT);
  const hash = hashKey(envKey);
  const id = `key_bootstrap_${hash.slice(0, 16)}`;
  const existing = keys.find((k) => k.id === id);
  for (const k of keys) {
    if (k.kind === 'bootstrap' && k.revoked_at === null && k.key_hash !== hash) await store.saveKey({ ...k, revoked_at: Date.now() });
  }
  if (existing && existing.revoked_at === null && existing.project_id) return;
  const active = new Set((await store.listProjects(DEFAULT_TENANT)).filter((p) => !p.archived).map((p) => p.id));
  const previous = keys
    .filter((k) => k.kind === 'bootstrap' && active.has(k.project_id))
    .sort((a, b) => b.created_at - a.created_at)[0];
  const projectId = existing?.project_id || previous?.project_id || (await ensureBootstrapProject()).id;
  if (existing && existing.revoked_at === null) await store.saveKey({ ...existing, project_id: projectId });
  else await store.saveKey(keyRecord(DEFAULT_TENANT, projectId, envKey, 'IVY_INGEST_API_KEY', 'bootstrap', id));
}

/** Gives tenants from before workspaces a slug. Idempotent; the API runs it on startup. */
export async function ensureWorkspaceSlugs(): Promise<void> {
  const store = tenancyStore();
  for (const tenant of await store.listTenants()) {
    if (tenant.slug) continue;
    if (tenant.id === DEFAULT_TENANT) await store.saveTenant({ ...tenant, slug: DEFAULT_TENANT });
    else await claimWorkspaceSlug(tenant, slugify(tenant.name));
  }
}

const autoTraceKeys = new Map<string, Promise<string | null>>();

/**
 * The ingest key written into the Lambda functions of a project. For the project of the self-hosted
 * bootstrap key (IVY_INGEST_API_KEY), that key: its plaintext already lives in the environment.
 * Otherwise a system-managed "auto-trace" key of the project, minted on first use and stored hashed
 * plus encrypted with IVY_SECRET_KEY so it can be written into new functions later. Null when
 * neither is possible, or the project is archived or unknown.
 */
export async function autoTraceKey(tenantId: string, projectId: string): Promise<string | null> {
  if (!projectId) return null;
  const cacheKey = `${tenantId}/${projectId}`;
  let pending = autoTraceKeys.get(cacheKey);
  if (!pending) {
    pending = loadAutoTraceKey(tenantId, projectId);
    autoTraceKeys.set(cacheKey, pending);
    pending.then((key) => key ?? autoTraceKeys.delete(cacheKey)).catch(() => autoTraceKeys.delete(cacheKey));
  }
  return pending;
}

async function loadAutoTraceKey(tenantId: string, projectId: string): Promise<string | null> {
  const envKey = process.env.IVY_INGEST_API_KEY?.trim();
  if (tenantId === DEFAULT_TENANT && envKey) {
    const bootstrap = await tenancyStore().findKeyByHash(hashKey(envKey));
    if (bootstrap?.tenant.id === DEFAULT_TENANT && bootstrap.key.project_id === projectId) return bootstrap.project?.archived === false ? envKey : null;
  }
  return loadOrMintAutoTraceKey(tenantId, projectId);
}

async function loadOrMintAutoTraceKey(tenantId: string, projectId: string): Promise<string | null> {
  const secret = serverSecret();
  if (!secret) return null;
  const store = tenancyStore();
  // Auto-trace keys always name their project. The oldest active one, so that every process picks
  // the same key if two were ever minted at once.
  const existing = (await store.listKeys(tenantId))
    .filter((k) => k.kind === 'auto-trace' && k.revoked_at === null && k.encrypted_key && k.project_id === projectId)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  for (const k of existing) {
    try {
      return decrypt(k.encrypted_key, secret);
    } catch {
      // Encrypted with a different IVY_SECRET_KEY; mint a new one below.
    }
  }
  if (!(await store.getTenant(tenantId))) return null;
  const project = (await store.listProjects(tenantId)).find((p) => p.id === projectId);
  if (!project || project.archived) return null;
  const key = newApiKey();
  await store.saveKey({
    ...keyRecord(tenantId, projectId, key, 'Auto-trace (Lambda functions)', 'auto-trace'),
    encrypted_key: encrypt(key, secret),
  });
  return key;
}

export function resetAutoTraceKeysForTests() {
  autoTraceKeys.clear();
}
