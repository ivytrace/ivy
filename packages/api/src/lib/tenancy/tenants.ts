import { hashKey, keyPrefix, newApiKey, newKeyId, newTenantId } from './ids.js';
import { decrypt, encrypt, serverSecret } from './secret-box.js';
import { DEFAULT_SHARD, shardConfigs } from './shards.js';
import { tenancyStore, type ApiKeyRecord, type KeyKind, type TenantRecord } from './store.js';

export const DEFAULT_TENANT = 'default';

export async function createTenant(name: string, shardId = DEFAULT_SHARD, id = newTenantId()): Promise<TenantRecord> {
  if (!shardConfigs().has(shardId)) throw new Error(`Unknown shard ${shardId}`);
  const tenant = { id, name, shard_id: shardId, created_at: Date.now() };
  await tenancyStore().saveTenant(tenant);
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

function keyRecord(tenantId: string, key: string, name: string, kind: KeyKind, id = newKeyId()): ApiKeyRecord {
  return {
    tenant_id: tenantId,
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

/** Mints a key. The plaintext is returned once and only its hash is stored. */
export async function createApiKey(tenantId: string, name: string): Promise<{ key: string; record: ApiKeyRecord }> {
  if (!(await tenancyStore().getTenant(tenantId))) throw new Error(`Unknown tenant ${tenantId}`);
  const key = newApiKey();
  const record = keyRecord(tenantId, key, name, 'user');
  await tenancyStore().saveKey(record);
  return { key, record };
}

export async function revokeApiKey(tenantId: string, keyId: string): Promise<ApiKeyRecord> {
  const record = (await tenancyStore().listKeys(tenantId)).find((k) => k.id === keyId);
  if (!record) throw new Error(`Unknown key ${keyId} for tenant ${tenantId}`);
  const revoked = { ...record, revoked_at: record.revoked_at ?? Date.now() };
  await tenancyStore().saveKey(revoked);
  if (record.kind === 'auto-trace') autoTraceKeys.delete(tenantId);
  return revoked;
}

/**
 * Self-hosted bootstrap: the `default` tenant always exists, and IVY_INGEST_API_KEY (when set) is
 * its key. The key ID is derived from the hash, so concurrent or repeated runs write the same row.
 * Setting the variable to a new value revokes the previous bootstrap key; unsetting it revokes
 * nothing (use the tenants CLI).
 */
export async function ensureDefaultTenant(envKey = process.env.IVY_INGEST_API_KEY?.trim()): Promise<void> {
  const store = tenancyStore();
  if (!(await store.getTenant(DEFAULT_TENANT))) await createTenant('Default', DEFAULT_SHARD, DEFAULT_TENANT);
  if (!envKey) return;
  const keys = await store.listKeys(DEFAULT_TENANT);
  const hash = hashKey(envKey);
  for (const k of keys) {
    if (k.kind === 'bootstrap' && k.revoked_at === null && k.key_hash !== hash) await store.saveKey({ ...k, revoked_at: Date.now() });
  }
  const id = `key_bootstrap_${hash.slice(0, 16)}`;
  const existing = keys.find((k) => k.id === id);
  if (existing && existing.revoked_at === null) return;
  await store.saveKey(keyRecord(DEFAULT_TENANT, envKey, 'IVY_INGEST_API_KEY', 'bootstrap', id));
}

const autoTraceKeys = new Map<string, Promise<string | null>>();

/**
 * The ingest key written into a tenant's Lambda functions. For `default` with IVY_INGEST_API_KEY
 * set, that key (its plaintext already lives in the environment). Otherwise a system-managed
 * "auto-trace" key, minted on first use and stored hashed plus encrypted with IVY_SECRET_KEY so it
 * can be written into new functions later. Null when neither is possible.
 */
export function autoTraceKey(tenantId: string): Promise<string | null> {
  const envKey = process.env.IVY_INGEST_API_KEY?.trim();
  if (tenantId === DEFAULT_TENANT && envKey) return Promise.resolve(envKey);
  let pending = autoTraceKeys.get(tenantId);
  if (!pending) {
    pending = loadOrMintAutoTraceKey(tenantId);
    autoTraceKeys.set(tenantId, pending);
    pending.then((key) => key ?? autoTraceKeys.delete(tenantId)).catch(() => autoTraceKeys.delete(tenantId));
  }
  return pending;
}

async function loadOrMintAutoTraceKey(tenantId: string): Promise<string | null> {
  const secret = serverSecret();
  if (!secret) return null;
  const store = tenancyStore();
  // The oldest active one, so that every process picks the same key if two were ever minted at once.
  const existing = (await store.listKeys(tenantId))
    .filter((k) => k.kind === 'auto-trace' && k.revoked_at === null && k.encrypted_key)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  for (const k of existing) {
    try {
      return decrypt(k.encrypted_key, secret);
    } catch {
      // Encrypted with a different IVY_SECRET_KEY; mint a new one below.
    }
  }
  if (!(await store.getTenant(tenantId))) return null;
  const key = newApiKey();
  await store.saveKey({ ...keyRecord(tenantId, key, 'Auto-trace (Lambda functions)', 'auto-trace'), encrypted_key: encrypt(key, secret) });
  return key;
}

export function resetAutoTraceKeysForTests() {
  autoTraceKeys.clear();
}
