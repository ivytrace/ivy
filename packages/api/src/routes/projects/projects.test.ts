import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../../lib/aws/memory-store.js';
import { targetProject } from '../../lib/aws/rules.js';
import { setAwsStore } from '../../lib/aws/store.js';
import { loadAssigner } from '../../lib/aws/sync.js';
import type { AwsAccount } from '../../lib/aws/types.js';
import { derivedProjectId, hashKey } from '../../lib/tenancy/ids.js';
import { createProject } from '../../lib/tenancy/projects.js';
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

const projects = async () => (await call('GET', '/projects?archived=1')).body.items as Record<string, unknown>[];

beforeEach(async () => {
  store = await resetTenancyForTests();
  setAwsStore(memoryStore().store);
  workspace = await testWorkspace('Acme', 'acme');
  first = (await store.listProjects(workspace.id))[0];
  prod = await createProject(workspace.id, { name: 'Checkout (prod)', slug: 'checkout-prod' });
  staging = await createProject(workspace.id, { name: 'Checkout (staging)', slug: 'checkout-staging' });
});

describe('projects without a default', () => {
  it('presents projects without a default flag, and workspaces without a default project', async () => {
    expect((await projects()).map((p) => [p.slug, p.archived]).sort()).toEqual([
      ['checkout-prod', false],
      ['checkout-staging', false],
      ['default', false],
    ]);
    expect((await projects()).some((p) => 'default' in p)).toBe(false);
    expect('default_project_id' in (await call('GET', '')).body).toBe(false);
  });

  it('archives any project with the normal flow, the last active one included, and unarchives it', async () => {
    for (const slug of ['default', 'checkout-prod', 'checkout-staging']) {
      expect(await call('PATCH', `/p/${slug}`, { archived: true, new_default: 'checkout-prod' })).toMatchObject({ status: 200, body: { slug, archived: true } });
    }
    expect((await call('GET', '/projects')).body.items).toEqual([]);
    expect((await call('PATCH', '/p/checkout-prod', { archived: false })).body).toMatchObject({ archived: false });
    expect((await call('GET', '/projects')).body.items.map((p: { slug: string }) => p.slug)).toEqual(['checkout-prod']);
  });

  it('has no default_project on the workspace any more', async () => {
    expect((await call('PATCH', '', { default_project: 'checkout-staging' }, 'member')).status).toBe(403);
    const res = await call('PATCH', '', { name: 'Acme 2', default_project: 'checkout-staging' });
    expect(res).toMatchObject({ status: 200, body: { name: 'Acme 2' } });
    expect(res.body.default_project_id).toBeUndefined();
  });
});

describe('keys, rules and functions name their project', () => {
  // The key's project as ingest (packages/ingest) resolves it: none without a project, or with an archived or missing one.
  const keyCache = () => ({
    async resolve(key: string) {
      const match = await store.findKeyByHash(hashKey(key));
      if (!match?.key.project_id || !match.project || match.project.archived) return null;
      return { projectId: match.project.id };
    },
  });

  it('resolves no fallback for keys without a project; keys of an archived project stop working', async () => {
    await store.saveKey({ tenant_id: workspace.id, project_id: '', id: 'key_old', name: 'old', kind: 'user', key_hash: hashKey('old-key'), prefix: 'old', encrypted_key: '', created_at: 1, revoked_at: null });
    const { key: explicit } = await createApiKey(workspace.id, first.id, 'ci');
    const { key: other } = await createApiKey(workspace.id, staging.id, 'ci');
    expect(await keyCache().resolve('old-key')).toBeNull();
    expect((await keyCache().resolve(explicit))?.projectId).toBe(first.id);
    expect((await call('GET', '/p/default/keys')).body.items).toHaveLength(1);

    await call('PATCH', '/p/default', { archived: true });
    expect(await keyCache().resolve(explicit)).toBeNull();
    expect((await keyCache().resolve(other))?.projectId).toBe(staging.id);
  });

  it('binds the IVY_INGEST_API_KEY bootstrap key to the "Default" project; archiving that disables the key', async () => {
    await ensureDefaultTenant('dev-ingest-key');
    const other = await createProject('default', { name: 'Other' });
    expect((await keyCache().resolve('dev-ingest-key'))?.projectId).toBe(derivedProjectId('default'));
    vi.stubEnv('IVY_INGEST_API_KEY', 'dev-ingest-key');
    expect(await autoTraceKey('default', derivedProjectId('default'))).toBe('dev-ingest-key');
    expect(await autoTraceKey('default', other.id)).toBeNull();

    const app = await appFor();
    await app.request('/api/w/default/p/default', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }) });
    expect(await keyCache().resolve('dev-ingest-key')).toBeNull();
    // Restarting doesn't move it elsewhere.
    await ensureDefaultTenant('dev-ingest-key');
    expect((await store.listKeys('default')).filter((k) => k.kind === 'bootstrap')).toMatchObject([{ project_id: derivedProjectId('default'), revoked_at: null }]);
    vi.unstubAllEnvs();
  });

  it('refuses rules and manual choices without a project; ivy:trace=true alone needs a project', async () => {
    await expect(targetProject(workspace.id, undefined)).rejects.toThrow(/project is required/);
    expect(await targetProject(workspace.id, 'checkout-prod')).toBe(prod.id);

    const assigner = await loadAssigner(workspace.id);
    const account = { account_id: '123456789012' } as AwsAccount;
    const fn = { name: 'checkout', tags: { 'ivy:trace': 'true' } } as unknown as Parameters<typeof assigner.assign>[2];
    expect(assigner.assign(account, 'eu-west-1', fn)).toMatchObject({ traced: false, state: 'needs_project' });
  });
});
