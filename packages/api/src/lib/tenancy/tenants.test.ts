import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { derivedProjectId, hashKey } from './ids.js';
import { createProject, forgetProjects, updateProject } from './projects.js';
import { decrypt, encrypt } from './secret-box.js';
import { memoryTenancyStore, setTenancyStore, type TenancyStore } from './store.js';
import { assignProjectlessKeys, autoTraceKey, createApiKey, createTenant, ensureDefaultTenant, resetAutoTraceKeysForTests, revokeApiKey } from './tenants.js';
import type { ApiKeyRecord } from './store.js';

let store: TenancyStore;

const oldKey = (tenant: string, key: string, kind: ApiKeyRecord['kind'] = 'user'): ApiKeyRecord => ({
  tenant_id: tenant, project_id: '', id: `key_${key}`, name: key, kind, key_hash: hashKey(key), prefix: key, encrypted_key: '', created_at: 1, revoked_at: null,
});

beforeEach(() => {
  store = memoryTenancyStore();
  setTenancyStore(store);
  resetAutoTraceKeysForTests();
  forgetProjects();
});

afterEach(() => vi.unstubAllEnvs());

describe('tenants and keys', () => {
  it('bootstraps the default tenant with IVY_INGEST_API_KEY bound to an ordinary "Default" project, idempotently, and rotates it', async () => {
    await ensureDefaultTenant('dev-ingest-key');
    await ensureDefaultTenant('dev-ingest-key');
    expect((await store.getTenant('default'))?.shard_id).toBe('shard-1');
    expect(await store.listProjects('default')).toMatchObject([{ id: derivedProjectId('default'), slug: 'default', name: 'Default', archived: false }]);
    expect(await store.listKeys('default')).toMatchObject([{ kind: 'bootstrap', project_id: derivedProjectId('default') }]);
    expect((await store.findKeyByHash(hashKey('dev-ingest-key')))?.project?.slug).toBe('default');

    await ensureDefaultTenant(undefined);
    expect((await store.findKeyByHash(hashKey('dev-ingest-key')))?.tenant.id).toBe('default');

    // A new value revokes the old key and takes over its project, also after a rename.
    const [project] = await store.listProjects('default');
    await updateProject(project, { name: 'Checkout' });
    const other = await createProject('default', { name: 'Other' });
    await ensureDefaultTenant('rotated');
    expect(await store.findKeyByHash(hashKey('dev-ingest-key'))).toBeNull();
    expect((await store.findKeyByHash(hashKey('rotated')))?.project).toMatchObject({ id: project.id, name: 'Checkout' });
    expect((await store.listProjects('default')).map((p) => p.id)).toEqual([project.id, other.id]);
  });

  it('creates the default tenant without a project when there is no bootstrap key', async () => {
    await ensureDefaultTenant(undefined);
    expect(await store.getTenant('default')).toMatchObject({ slug: 'default' });
    expect(await store.listProjects('default')).toEqual([]);
  });

  it('creates keys shown once and stored only as a hash', async () => {
    const tenant = await createTenant('Acme');
    expect(tenant.id).toMatch(/^ten_[0-9A-Za-z]{21}$/);
    const project = await createProject(tenant.id, { name: 'Checkout' });
    const { key, record } = await createApiKey(tenant.id, project.id, 'ci');
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
    await expect(createApiKey('ten_missing', 'prj_x', 'x')).rejects.toThrow(/Unknown tenant/);
  });
});

describe('workspaces and projects', () => {
  it('gives every workspace a slug and no projects', async () => {
    const acme = await createTenant('Acme Inc.');
    const again = await createTenant('Acme Inc.');
    expect(acme.slug).toBe('acme-inc');
    expect(again.slug).toBe('acme-inc-2');
    expect((await createTenant('Acme Inc.')).slug).toBe('acme-inc-3');
    expect(await store.listProjects(acme.id)).toEqual([]);
  });

  it('resolves no project for keys without one', async () => {
    const tenant = await createTenant('Acme');
    await store.saveProject({ tenant_id: tenant.id, id: derivedProjectId(tenant.id), slug: 'default', name: 'Default', archived: false, created_at: 1 });
    await store.saveKey(oldKey(tenant.id, 'old-key'));
    expect((await store.findKeyByHash(hashKey('old-key')))?.project).toBeNull();
  });

  it("migrates keys without a project to the workspace's former default project, explicitly", async () => {
    const derived = await createTenant('Derived');
    await store.saveProject({ tenant_id: derived.id, id: derivedProjectId(derived.id), slug: 'default', name: 'Default', archived: false, created_at: 1 });
    const moved = await createTenant('Moved');
    const prod = await createProject(moved.id, { name: 'Prod' });
    await store.saveTenant({ ...moved, default_project_id: prod.id });
    await store.saveKey(oldKey(derived.id, 'old-key'));
    await store.saveKey(oldKey(moved.id, 'hosted-key'));
    await store.saveKey({ ...oldKey(moved.id, 'revoked-key'), revoked_at: 5 });
    await store.saveKey(oldKey('ten_gone', 'orphan-key'));

    expect(await assignProjectlessKeys()).toBe(3);
    expect((await store.listKeys(derived.id))[0].project_id).toBe(derivedProjectId(derived.id));
    expect((await store.listKeys(moved.id)).map((k) => k.project_id)).toEqual([prod.id, prod.id]);
    expect((await store.findKeyByHash(hashKey('hosted-key')))?.project?.id).toBe(prod.id);
    expect((await store.findKeyByHash(hashKey('old-key')))?.project?.id).toBe(derivedProjectId(derived.id));
    expect(await assignProjectlessKeys()).toBe(0);
  });

  it('migrates an old bootstrap key without a project, and keeps it there', async () => {
    await createTenant('Default', undefined, 'default');
    await store.saveProject({ tenant_id: 'default', id: derivedProjectId('default'), slug: 'default', name: 'Default', archived: false, created_at: 1 });
    await store.saveKey({ ...oldKey('default', 'dev-ingest-key', 'bootstrap'), id: `key_bootstrap_${hashKey('dev-ingest-key').slice(0, 16)}` });
    await assignProjectlessKeys();
    await ensureDefaultTenant('dev-ingest-key');
    expect(await store.listKeys('default')).toMatchObject([{ kind: 'bootstrap', project_id: derivedProjectId('default'), revoked_at: null }]);
  });

  it('mints keys for a given project and refuses archived ones', async () => {
    const tenant = await createTenant('Acme');
    const staging = await createProject(tenant.id, { name: 'Staging' });
    const { key } = await createApiKey(tenant.id, staging.id, 'ci');
    expect((await store.findKeyByHash(hashKey(key)))?.project?.slug).toBe('staging');
    await updateProject(staging, { archived: true });
    await expect(createApiKey(tenant.id, staging.id, 'ci')).rejects.toThrow(/archived/);
    await expect(createApiKey(tenant.id, 'prj_nope', 'ci')).rejects.toThrow(/Unknown project/);
  });
});

describe('auto-trace key', () => {
  it('is one key per project', async () => {
    vi.stubEnv('IVY_SECRET_KEY', 'server-secret');
    const tenant = await createTenant('Acme');
    const production = await createProject(tenant.id, { name: 'Prod' });
    const staging = await createProject(tenant.id, { name: 'Staging' });
    const prod = await autoTraceKey(tenant.id, production.id);
    const stage = await autoTraceKey(tenant.id, staging.id);
    expect(prod).not.toBe(stage);
    expect((await store.findKeyByHash(hashKey(stage!)))?.project?.id).toBe(staging.id);
    expect((await store.findKeyByHash(hashKey(prod!)))?.project?.id).toBe(production.id);
    expect(await autoTraceKey(tenant.id, '')).toBeNull();
  });

  it("uses IVY_INGEST_API_KEY for the bootstrap key's project only", async () => {
    vi.stubEnv('IVY_INGEST_API_KEY', 'dev-ingest-key');
    vi.stubEnv('IVY_SECRET_KEY', '');
    await ensureDefaultTenant('dev-ingest-key');
    const other = await createProject('default', { name: 'Other' });
    expect(await autoTraceKey('default', derivedProjectId('default'))).toBe('dev-ingest-key');
    expect(await autoTraceKey('default', other.id)).toBeNull();
  });

  it('is unavailable for other tenants without IVY_SECRET_KEY', async () => {
    vi.stubEnv('IVY_SECRET_KEY', '');
    const tenant = await createTenant('Acme');
    const project = await createProject(tenant.id, { name: 'Prod' });
    expect(await autoTraceKey(tenant.id, project.id)).toBeNull();
  });

  it('mints one key per tenant, stores it hashed and encrypted, and re-mints after revocation', async () => {
    vi.stubEnv('IVY_SECRET_KEY', 'server-secret');
    const tenant = await createTenant('Acme');
    const { id } = await createProject(tenant.id, { name: 'Prod' });
    const key = await autoTraceKey(tenant.id, id);
    expect(key).toMatch(/^ivy_/);
    resetAutoTraceKeysForTests();
    expect(await autoTraceKey(tenant.id, id)).toBe(key);

    const [record] = await store.listKeys(tenant.id);
    expect(record.kind).toBe('auto-trace');
    expect(record.key_hash).toBe(hashKey(key!));
    expect(record.encrypted_key).not.toContain(key);
    expect(decrypt(record.encrypted_key, 'server-secret')).toBe(key);

    await revokeApiKey(tenant.id, record.id);
    const next = await autoTraceKey(tenant.id, id);
    expect(next).toMatch(/^ivy_/);
    expect(next).not.toBe(key);
  });

  it('mints a new key when the stored one was encrypted with another secret', async () => {
    const tenant = await createTenant('Acme');
    const { id } = await createProject(tenant.id, { name: 'Prod' });
    vi.stubEnv('IVY_SECRET_KEY', 'old');
    const key = await autoTraceKey(tenant.id, id);
    resetAutoTraceKeysForTests();
    vi.stubEnv('IVY_SECRET_KEY', 'new');
    const next = await autoTraceKey(tenant.id, id);
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
