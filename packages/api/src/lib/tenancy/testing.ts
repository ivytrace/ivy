import { createApp } from '../../app.js';
import { clearTenantCacheForTests } from './context.js';
import { defaultProjectId } from './ids.js';
import { clearMemberCacheForTests, fixedWorkspaceAccess } from './members.js';
import { forgetProjects } from './projects.js';
import { memoryTenancyStore, setTenancyStore, tenancyStore, type MemberRole, type TenancyStore, type TenantRecord } from './store.js';
import { createTenant, ensureDefaultTenant, resetAutoTraceKeysForTests } from './tenants.js';

/** Fresh in-memory control plane with the `default` workspace and its default project. For tests. */
export async function resetTenancyForTests(): Promise<TenancyStore> {
  const store = memoryTenancyStore();
  setTenancyStore(store);
  clearTenantCacheForTests();
  clearMemberCacheForTests();
  forgetProjects();
  resetAutoTraceKeysForTests();
  await ensureDefaultTenant(undefined);
  return store;
}

/** A workspace in the current (test) store, with a slug. */
export const testWorkspace = (name: string, slug: string) => createTenant(name, undefined, undefined, slug);

/** The app with fixed access to one workspace (default: `default`, as owner). */
export async function appFor(workspace?: TenantRecord, role: MemberRole = 'owner') {
  const ws = workspace ?? (await tenancyStore().getTenant('default'))!;
  return createApp({ uiDir: '/nonexistent', access: fixedWorkspaceAccess(ws, role) });
}

export const DEFAULT_PROJECT = defaultProjectId('default');
