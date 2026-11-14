import type { AuthUser } from '../auth/user.js';
import { DEFAULT_TENANT } from '../tenancy/tenants.js';
import { alertStore } from './store.js';

const remembered = new Set<string>();

/**
 * Single-workspace mode has no member rows, so the digest's recipients there are the users who signed
 * in: the first request of a user per process records them (with their email, subscribed).
 */
export async function rememberDefaultUser(user: AuthUser | null) {
  if (!user?.email || remembered.has(user.sub)) return;
  remembered.add(user.sub);
  try {
    const store = alertStore();
    const existing = (await store.listPrefs(DEFAULT_TENANT)).find((p) => p.sub === user.sub);
    if (existing && existing.email === user.email) return;
    await store.savePref({ tenant_id: DEFAULT_TENANT, sub: user.sub, email: user.email, digest: existing?.digest ?? true });
  } catch (err) {
    remembered.delete(user.sub);
    console.error('[digest] could not record user', (err as Error).message);
  }
}

export const forgetRememberedUsersForTests = () => remembered.clear();

/** Whether this user gets the digest of this workspace (default: yes). */
export async function digestSubscribed(tenantId: string, sub: string): Promise<boolean> {
  return (await alertStore().listPrefs(tenantId)).find((p) => p.sub === sub)?.digest ?? true;
}

export async function setDigestSubscription(tenantId: string, sub: string, email: string, digest: boolean) {
  const existing = (await alertStore().listPrefs(tenantId)).find((p) => p.sub === sub);
  await alertStore().savePref({ tenant_id: tenantId, sub, email: email || existing?.email || '', digest });
}
