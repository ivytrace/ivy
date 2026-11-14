import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashKey } from './ids.js';
import { decrypt, encrypt } from './secret-box.js';
import { memoryTenancyStore, setTenancyStore, type TenancyStore } from './store.js';
import { autoTraceKey, createApiKey, createTenant, ensureDefaultTenant, resetAutoTraceKeysForTests, revokeApiKey } from './tenants.js';

let store: TenancyStore;

beforeEach(() => {
  store = memoryTenancyStore();
  setTenancyStore(store);
  resetAutoTraceKeysForTests();
});

afterEach(() => vi.unstubAllEnvs());

describe('tenants and keys', () => {
  it('bootstraps the default tenant with IVY_INGEST_API_KEY, idempotently, and rotates it', async () => {
    await ensureDefaultTenant('dev-ingest-key');
    await ensureDefaultTenant('dev-ingest-key');
    expect((await store.getTenant('default'))?.shard_id).toBe('shard-1');
    expect(await store.listKeys('default')).toHaveLength(1);
    expect((await store.findKeyByHash(hashKey('dev-ingest-key')))?.tenant.id).toBe('default');

    await ensureDefaultTenant(undefined);
    expect((await store.findKeyByHash(hashKey('dev-ingest-key')))?.tenant.id).toBe('default');

    await ensureDefaultTenant('rotated');
    expect(await store.findKeyByHash(hashKey('dev-ingest-key'))).toBeNull();
    expect((await store.findKeyByHash(hashKey('rotated')))?.tenant.id).toBe('default');
  });

  it('creates keys shown once and stored only as a hash', async () => {
    const tenant = await createTenant('Acme');
    expect(tenant.id).toMatch(/^ten_[0-9A-Za-z]{21}$/);
    const { key, record } = await createApiKey(tenant.id, 'ci');
    expect(key).toMatch(/^ivy_[0-9A-Za-z]{40}$/);
    expect(record.id).toMatch(/^key_/);
    expect(record.prefix).toBe(key.slice(0, 10));
    expect(JSON.stringify(await store.listKeys(tenant.id))).not.toContain(key);
    expect((await store.findKeyByHash(hashKey(key)))?.tenant.id).toBe(tenant.id);

    await revokeApiKey(tenant.id, record.id);
    expect(await store.findKeyByHash(hashKey(key))).toBeNull();
  });

  it('rejects unknown shards and tenants', async () => {
    await expect(createTenant('x', 'shard-9')).rejects.toThrow(/Unknown shard/);
    await expect(createApiKey('ten_missing', 'x')).rejects.toThrow(/Unknown tenant/);
  });
});

describe('auto-trace key', () => {
  it('uses IVY_INGEST_API_KEY for the default tenant', async () => {
    vi.stubEnv('IVY_INGEST_API_KEY', 'dev-ingest-key');
    expect(await autoTraceKey('default')).toBe('dev-ingest-key');
  });

  it('is unavailable for other tenants without IVY_SECRET_KEY', async () => {
    vi.stubEnv('IVY_SECRET_KEY', '');
    const tenant = await createTenant('Acme');
    expect(await autoTraceKey(tenant.id)).toBeNull();
  });

  it('mints one key per tenant, stores it hashed and encrypted, and re-mints after revocation', async () => {
    vi.stubEnv('IVY_SECRET_KEY', 'server-secret');
    const tenant = await createTenant('Acme');
    const key = await autoTraceKey(tenant.id);
    expect(key).toMatch(/^ivy_/);
    resetAutoTraceKeysForTests();
    expect(await autoTraceKey(tenant.id)).toBe(key);

    const [record] = await store.listKeys(tenant.id);
    expect(record.kind).toBe('auto-trace');
    expect(record.key_hash).toBe(hashKey(key!));
    expect(record.encrypted_key).not.toContain(key);
    expect(decrypt(record.encrypted_key, 'server-secret')).toBe(key);

    await revokeApiKey(tenant.id, record.id);
    const next = await autoTraceKey(tenant.id);
    expect(next).toMatch(/^ivy_/);
    expect(next).not.toBe(key);
  });

  it('mints a new key when the stored one was encrypted with another secret', async () => {
    const tenant = await createTenant('Acme');
    vi.stubEnv('IVY_SECRET_KEY', 'old');
    const key = await autoTraceKey(tenant.id);
    resetAutoTraceKeysForTests();
    vi.stubEnv('IVY_SECRET_KEY', 'new');
    const next = await autoTraceKey(tenant.id);
    expect(next).not.toBe(key);
  });
});

describe('secret box', () => {
  it('round-trips and detects tampering or a wrong secret', () => {
    const box = encrypt('ivy_secret', 's1');
    expect(decrypt(box, 's1')).toBe('ivy_secret');
    expect(() => decrypt(box, 's2')).toThrow();
    const parts = box.split('.');
    parts[3] = Buffer.from('x').toString('base64url');
    expect(() => decrypt(parts.join('.'), 's1')).toThrow();
  });
});
