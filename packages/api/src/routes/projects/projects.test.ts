import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../../lib/aws/memory-store.js';
import { targetProject } from '../../lib/aws/rules.js';
import { setAwsStore } from '../../lib/aws/store.js';
import { loadAssigner } from '../../lib/aws/sync.js';
import type { AwsAccount } from '../../lib/aws/types.js';
import { KeyCache } from '../../lib/ingest/key-cache.js';
import { defaultProjectId, hashKey } from '../../lib/tenancy/ids.js';
import { createProject, defaultProjectOf } from '../../lib/tenancy/projects.js';
import type { ProjectRecord, TenancyStore, TenantRecord } from '../../lib/tenancy/store.js';
import { autoTraceKey, createApiKey, ensureDefaultTenant } from '../../lib/tenancy/tenants.js';
import { appFor, resetTenancyForTests, testWorkspace } from '../../lib/tenancy/testing.js';

let store: TenancyStore;
let workspace: TenantRecord;
let first: ProjectRecord;
let prod: ProjectRecord;
let staging: ProjectRecord;

async function call(method: string, path: string, body?: unknown, role: 'owner' | 'member' = 'owner') {
  const app = await appFor(workspace, role);
  const res = await app.request(`/api/w/acme${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const projects = async () => (await call('GET', '/projects?archived=1')).body.items as { slug: string; default: unknown; archived: unknown }[];
const defaultSlug = async () => (await projects()).find((p) => p.default)?.slug;

beforeEach(async () => {
  store = await resetTenancyForTests();
  setAwsStore(memoryStore().store);
  workspace = await testWorkspace('Acme', 'acme');
  first = (await store.listProjects(workspace.id))[0];
  // Distinct creation times, so "the oldest remaining project" is well defined.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 1000 });
  prod = await createProject(workspace.id, { name: 'Checkout (prod)', slug: 'checkout-prod' });
  vi.setSystemTime(Date.now() + 1000);
  staging = await createProject(workspace.id, { name: 'Checkout (staging)', slug: 'checkout-staging' });
  vi.useRealTimers();
});

describe('default project', () => {
  it('starts as the project with the derived ID, and presents default and archived as booleans', async () => {
    expect(first.id).toBe(defaultProjectId(workspace.id));
    expect(await projects()).toEqual([
      expect.objectContaining({ slug: 'default', default: true, archived: false }),
      expect.objectContaining({ slug: 'checkout-prod', default: false, archived: false }),
      expect.objectContaining({ slug: 'checkout-staging', default: false, archived: false }),
    ]);
    expect((await call('GET', '')).body.default_project_id).toBe(first.id);
  });

  it('moves to the oldest remaining active project when the default is archived without new_default', async () => {
    const res = await call('PATCH', '/p/default', { archived: true });
    expect(res).toMatchObject({ status: 200, body: { slug: 'default', archived: true, default: false } });
    expect(await defaultSlug()).toBe('checkout-prod');
    expect((await store.getTenant(workspace.id))?.default_project_id).toBe(prod.id);
  });

  it('moves to new_default (slug or ID) when the default is archived', async () => {
    expect((await call('PATCH', '/p/default', { archived: true, new_default: 'checkout-staging' })).status).toBe(200);
    expect(await defaultSlug()).toBe('checkout-staging');
    expect((await call('PATCH', '/p/checkout-staging', { archived: true, new_default: prod.id })).status).toBe(200);
    expect(await defaultSlug()).toBe('checkout-prod');
  });

  it('refuses a new_default that is unknown, archived or the project being archived', async () => {
    await call('PATCH', '/p/checkout-staging', { archived: true });
    for (const new_default of ['nope', 'checkout-staging', 'default', 42]) {
      expect((await call('PATCH', '/p/default', { archived: true, new_default })).status).toBe(400);
    }
    expect(await defaultSlug()).toBe('default');
    expect((await projects()).find((p) => p.slug === 'default')?.archived).toBe(false);
  });

  it('refuses to archive the last active project', async () => {
    await call('PATCH', '/p/checkout-prod', { archived: true });
    await call('PATCH', '/p/checkout-staging', { archived: true });
    expect(await call('PATCH', '/p/default', { archived: true })).toEqual({ status: 409, body: { error: 'A workspace needs at least one project' } });
    expect((await call('PATCH', '/p/checkout-prod', { archived: false })).status).toBe(200);
    expect((await call('PATCH', '/p/default', { archived: true })).status).toBe(200);
    expect(await defaultSlug()).toBe('checkout-prod');
  });

  it('archives other projects without moving the default', async () => {
    expect((await call('PATCH', '/p/checkout-prod', { archived: true, new_default: 'checkout-staging' })).status).toBe(200);
    expect(await defaultSlug()).toBe('default');
  });

  it('can be changed without archiving, by members too, through PATCH /api/w/:workspace', async () => {
    const res = await call('PATCH', '', { default_project: 'checkout-staging' }, 'member');
    expect(res).toMatchObject({ status: 200, body: { slug: 'acme', default_project_id: staging.id } });
    expect(await defaultSlug()).toBe('checkout-staging');
    expect((await call('PATCH', '', { default_project: 'nope' })).status).toBe(400);
    await call('PATCH', '/p/checkout-prod', { archived: true });
    expect((await call('PATCH', '', { default_project: 'checkout-prod' })).status).toBe(400);
    expect((await call('PATCH', '', { name: 'Acme 2' }, 'member')).status).toBe(403);
    // A rename keeps the default.
    expect((await call('PATCH', '', { name: 'Acme 2' })).body).toMatchObject({ name: 'Acme 2', default_project_id: staging.id });
  });
});

describe('what follows the default project', () => {
  const keyCache = () => new KeyCache({ lookup: (hash) => store.findKeyByHash(hash) });

  it('keys without a project follow the new default; keys made for the archived project stop working', async () => {
    await store.saveKey({ tenant_id: workspace.id, project_id: '', id: 'key_old', name: 'old', kind: 'user', key_hash: hashKey('old-key'), prefix: 'old', encrypted_key: '', created_at: 1, revoked_at: null });
    const { key: explicit } = await createApiKey(workspace.id, first.id, 'ci');
    expect((await keyCache().resolve('old-key'))?.projectId).toBe(first.id);
    expect((await keyCache().resolve(explicit))?.projectId).toBe(first.id);

    await call('PATCH', '/p/default', { archived: true, new_default: 'checkout-staging' });
    expect((await keyCache().resolve('old-key'))?.projectId).toBe(staging.id);
    expect(await keyCache().resolve(explicit)).toBeNull();
    // Listed under the project they now send to.
    expect((await call('GET', '/p/checkout-staging/keys')).body.items.map((k: { id: string }) => k.id)).toEqual(['key_old']);
  });

  it('the IVY_INGEST_API_KEY bootstrap key follows the default workspace’s default project', async () => {
    await ensureDefaultTenant('dev-ingest-key');
    const other = await createProject('default', { name: 'Other' });
    expect((await keyCache().resolve('dev-ingest-key'))?.projectId).toBe(defaultProjectId('default'));
    const app = await appFor();
    await app.request('/api/w/default/p/default', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }) });
    expect((await keyCache().resolve('dev-ingest-key'))?.projectId).toBe(other.id);
    vi.stubEnv('IVY_INGEST_API_KEY', 'dev-ingest-key');
    expect(await autoTraceKey('default')).toBe('dev-ingest-key');
    expect(await autoTraceKey('default', other.id)).toBe('dev-ingest-key');
    vi.unstubAllEnvs();
  });

  it('auto-trace keys, rules without a project and functions traced without a project use the current default', async () => {
    vi.stubEnv('IVY_SECRET_KEY', 'server-secret');
    await call('PATCH', '', { default_project: 'checkout-prod' });
    expect(await defaultProjectOf(workspace.id)).toBe(prod.id);
    const key = await autoTraceKey(workspace.id);
    expect((await store.findKeyByHash(hashKey(key!)))?.project?.id).toBe(prod.id);
    expect(await targetProject(workspace.id, undefined)).toBe(prod.id);

    const assigner = await loadAssigner(workspace.id);
    const account = { account_id: '123456789012' } as AwsAccount;
    const fn = { name: 'checkout', tags: { 'ivy:trace': 'true' } } as unknown as Parameters<typeof assigner.assign>[2];
    expect(assigner.assign(account, 'eu-west-1', fn)).toMatchObject({ traced: true, projectId: prod.id });
    vi.unstubAllEnvs();
  });
});
