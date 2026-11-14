import { defaultProjectId, hashKey, keyPrefix, newApiKey, newKeyId, newTenantId } from './ids.js';
import { decrypt, encrypt, serverSecret } from './secret-box.js';
import { DEFAULT_SHARD, shardConfigs } from './shards.js';
import { slugify, uniqueSlug } from './slugs.js';
import { tenancyStore, type ApiKeyRecord, type KeyKind, type ProjectRecord, type TenantRecord } from './store.js';

export const DEFAULT_TENANT = 'default';
export const DEFAULT_PROJECT_SLUG = 'default';

const workspaceSlugTaken = async (slug: string) => slug === DEFAULT_TENANT || !!(await tenancyStore().findTenantBySlug(slug));

/** A free workspace slug based on `name` (or `slug` when given and free). */
export const freeWorkspaceSlug = (name: string) => uniqueSlug(slugify(name), workspaceSlugTaken);

/**
 * The project every workspace starts with. Its ID is derived from the tenant ID (`defaultProjectId`),
 * so creating it is idempotent and keys from before projects (`project_id = ''`) resolve to it.
 */
export async function ensureDefaultProject(tenantId: string): Promise<ProjectRecord> {
  const store = tenancyStore();
  const id = defaultProjectId(tenantId);
  const projects = await store.listProjects(tenantId);
  const existing = projects.find((p) => p.id === id);
  if (existing) return existing;
  const slug = projects.some((p) => p.slug === DEFAULT_PROJECT_SLUG) ? `${DEFAULT_PROJECT_SLUG}-${id.slice(4, 8)}` : DEFAULT_PROJECT_SLUG;
  const project: ProjectRecord = { tenant_id: tenantId, id, slug, name: 'Default', archived: false, created_at: Date.now() };
  await store.saveProject(project);
  return project;
}

export async function createTenant(name: string, shardId = DEFAULT_SHARD, id = newTenantId(), slug?: string): Promise<TenantRecord> {
  if (!shardConfigs().has(shardId)) throw new Error(`Unknown shard ${shardId}`);
  const tenant = {
    id,
    slug: slug ?? (id === DEFAULT_TENANT ? DEFAULT_TENANT : await freeWorkspaceSlug(name)),
    name,
    shard_id: shardId,
    created_at: Date.now(),
  };
  await tenancyStore().saveTenant(tenant);
  await ensureDefaultProject(tenant.id);
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

/** The project a key belongs to (keys from before projects belong to the default project). */
export const keyProjectId = (key: Pick<ApiKeyRecord, 'tenant_id' | 'project_id'>) => key.project_id || defaultProjectId(key.tenant_id);

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
  if (record.kind === 'auto-trace') autoTraceKeys.delete(`${tenantId}/${keyProjectId(record)}`);
  return revoked;
}

/**
 * Self-hosted bootstrap: the `default` tenant (with its default project) always exists, and
 * IVY_INGEST_API_KEY (when set) is a key of that project. The key ID is derived from the hash, so
 * concurrent or repeated runs write the same row. Setting the variable to a new value revokes the
 * previous bootstrap key; unsetting it revokes nothing (use the tenants CLI).
 */
export async function ensureDefaultTenant(envKey = process.env.IVY_INGEST_API_KEY?.trim()): Promise<void> {
  const store = tenancyStore();
  if (!(await store.getTenant(DEFAULT_TENANT))) await createTenant('Default', DEFAULT_SHARD, DEFAULT_TENANT);
  await ensureDefaultProject(DEFAULT_TENANT);
  if (!envKey) return;
  const keys = await store.listKeys(DEFAULT_TENANT);
  const hash = hashKey(envKey);
  for (const k of keys) {
    if (k.kind === 'bootstrap' && k.revoked_at === null && k.key_hash !== hash) await store.saveKey({ ...k, revoked_at: Date.now() });
  }
  const id = `key_bootstrap_${hash.slice(0, 16)}`;
  const existing = keys.find((k) => k.id === id);
  if (existing && existing.revoked_at === null) return;
  await store.saveKey(keyRecord(DEFAULT_TENANT, defaultProjectId(DEFAULT_TENANT), envKey, 'IVY_INGEST_API_KEY', 'bootstrap', id));
}

/**
 * Brings tenants from before workspaces/projects up to date: a slug for every tenant and a default
 * project in each. Idempotent; the API runs it on startup.
 */
export async function ensureWorkspaceDefaults(): Promise<void> {
  const store = tenancyStore();
  for (const tenant of await store.listTenants()) {
    if (!tenant.slug) {
      const slug = tenant.id === DEFAULT_TENANT ? DEFAULT_TENANT : await freeWorkspaceSlug(tenant.name);
      await store.saveTenant({ ...tenant, slug });
    }
    await ensureDefaultProject(tenant.id);
  }
}

const autoTraceKeys = new Map<string, Promise<string | null>>();

/**
 * The ingest key written into the Lambda functions of a project. For the default tenant's default
 * project with IVY_INGEST_API_KEY set, that key (its plaintext already lives in the environment).
 * Otherwise a system-managed "auto-trace" key of the project, minted on first use and stored hashed
 * plus encrypted with IVY_SECRET_KEY so it can be written into new functions later. Null when
 * neither is possible.
 */
export function autoTraceKey(tenantId: string, projectId = defaultProjectId(tenantId)): Promise<string | null> {
  const envKey = process.env.IVY_INGEST_API_KEY?.trim();
  if (tenantId === DEFAULT_TENANT && projectId === defaultProjectId(DEFAULT_TENANT) && envKey) return Promise.resolve(envKey);
  const cacheKey = `${tenantId}/${projectId}`;
  let pending = autoTraceKeys.get(cacheKey);
  if (!pending) {
    pending = loadOrMintAutoTraceKey(tenantId, projectId);
    autoTraceKeys.set(cacheKey, pending);
    pending.then((key) => key ?? autoTraceKeys.delete(cacheKey)).catch(() => autoTraceKeys.delete(cacheKey));
  }
  return pending;
}

async function loadOrMintAutoTraceKey(tenantId: string, projectId: string): Promise<string | null> {
  const secret = serverSecret();
  if (!secret) return null;
  const store = tenancyStore();
  // The oldest active one, so that every process picks the same key if two were ever minted at once.
  const existing = (await store.listKeys(tenantId))
    .filter((k) => k.kind === 'auto-trace' && k.revoked_at === null && k.encrypted_key && keyProjectId(k) === projectId)
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
