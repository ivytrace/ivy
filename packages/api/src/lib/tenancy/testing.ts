import { createApp } from '../../app.js';
import { clearTenantCacheForTests } from './context.js';
import { derivedProjectId } from './ids.js';
import { clearMemberCacheForTests, fixedWorkspaceAccess } from './members.js';
import { forgetProjects } from './projects.js';
import { memoryTenancyStore, setTenancyStore, tenancyStore, type MemberRole, type TenancyStore, type TenantRecord } from './store.js';
import { createTenant, ensureBootstrapProject, ensureDefaultTenant, resetAutoTraceKeysForTests } from './tenants.js';

/** Fresh in-memory control plane with the `default` workspace and its "Default" project (DEFAULT_PROJECT). For tests. */
export async function resetTenancyForTests(): Promise<TenancyStore> {
  const store = memoryTenancyStore();
  setTenancyStore(store);
  clearTenantCacheForTests();
  clearMemberCacheForTests();
  forgetProjects();
  resetAutoTraceKeysForTests();
  await ensureDefaultTenant(undefined);
  await ensureBootstrapProject();
  return store;
}

/** A project with slug `default` and the derived ID (`derivedProjectId`), so fixtures can name it without a lookup. */
export async function testProject(tenantId: string): Promise<void> {
  await tenancyStore().saveProject({ tenant_id: tenantId, id: derivedProjectId(tenantId), slug: 'default', name: 'Default', archived: false, created_at: 1 });
  forgetProjects(tenantId);
}

/** A workspace in the current (test) store, with a slug and a project (see testProject). */
export async function testWorkspace(name: string, slug: string): Promise<TenantRecord> {
  const workspace = await createTenant(name, undefined, undefined, slug);
  await testProject(workspace.id);
  return workspace;
}

/** The app with fixed access to one workspace (default: `default`, as owner). */
export async function appFor(workspace?: TenantRecord, role: MemberRole = 'owner') {
  const ws = workspace ?? (await tenancyStore().getTenant('default'))!;
  return createApp({ uiDir: '/nonexistent', access: fixedWorkspaceAccess(ws, role) });
}

/** The `default` workspace's "Default" project, as created for the self-hosted bootstrap key. */
export const DEFAULT_PROJECT = derivedProjectId('default');
