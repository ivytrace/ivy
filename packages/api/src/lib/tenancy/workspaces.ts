import { HTTPException } from 'hono/http-exception';
import type { AuthUser } from '../auth/user.js';
import { awsStore } from '../aws/store.js';
import { dropQueryUser } from '../clickhouse/workspace-query.js';
import { notify } from '../hooks/run.js';
import { forgetMemberships } from './members.js';
import { forgetProjects } from './projects.js';
import { DEFAULT_SHARD } from './shards.js';
import { isSlug } from './slugs.js';
import { tenancyStore, type MemberRole, type TenantRecord } from './store.js';
import { createTenant, DEFAULT_TENANT } from './tenants.js';

const bad = (message: string) => new HTTPException(400, { message });

function checkName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw bad('name must be a non-empty string');
  return name.trim().slice(0, 100);
}

async function checkSlug(slug: unknown, self?: string): Promise<string> {
  if (typeof slug !== 'string' || !isSlug(slug)) {
    throw bad('slug must be 1–40 lower-case letters, digits and dashes, starting and ending with a letter or digit');
  }
  const owner = slug === DEFAULT_TENANT ? { id: DEFAULT_TENANT } : await tenancyStore().findTenantBySlug(slug);
  if (owner && owner.id !== self) throw new HTTPException(409, { message: `The workspace slug "${slug}" is taken` });
  return slug;
}

/** A new workspace, without projects (the welcome wizard creates the first), owned by `user`. */
export async function createWorkspace(user: AuthUser, input: { name?: unknown; slug?: unknown }): Promise<TenantRecord> {
  const name = checkName(input.name);
  const slug = input.slug === undefined || input.slug === '' ? undefined : await checkSlug(input.slug);
  const workspace = await createTenant(name, DEFAULT_SHARD, undefined, slug);
  await tenancyStore().saveMember({ tenant_id: workspace.id, sub: user.sub, email: user.email ?? '', role: 'owner', created_at: Date.now() });
  forgetMemberships(user.sub);
  notify('on-workspace-created', { workspace: workspaceRef(workspace), owner: { sub: user.sub, email: user.email ?? null } });
  return workspace;
}

export const workspaceRef = (w: TenantRecord) => ({ id: w.id, slug: w.slug, name: w.name });

/** Renames a workspace or changes its slug. The default workspace keeps the slug `default`. */
export async function updateWorkspace(workspace: TenantRecord, input: { name?: unknown; slug?: unknown }): Promise<TenantRecord> {
  const next = { ...workspace };
  if (input.name !== undefined) next.name = checkName(input.name);
  if (input.slug !== undefined && input.slug !== workspace.slug) {
    if (workspace.id === DEFAULT_TENANT) throw new HTTPException(409, { message: 'The default workspace’s slug can’t change' });
    next.slug = await checkSlug(input.slug, workspace.id);
  }
  await tenancyStore().saveTenant(next);
  return next;
}

/**
 * Deletes a workspace: `confirm` must repeat its slug, and its AWS accounts must be disconnected
 * first (so no function is left sending with a revoked key). Revokes every key (ingest stops within
 * the key cache TTL), removes members and pending invitations. Spans stay until retention drops them.
 */
export async function deleteWorkspace(workspace: TenantRecord, confirm: unknown): Promise<void> {
  if (workspace.id === DEFAULT_TENANT) throw new HTTPException(409, { message: 'The default workspace can’t be deleted' });
  if (confirm !== workspace.slug) throw bad(`Type the workspace slug (${workspace.slug}) to confirm`);
  if ((await awsStore().listAccounts(workspace.id)).length) {
    throw new HTTPException(409, { message: 'Disconnect this workspace’s AWS accounts first' });
  }
  const store = tenancyStore();
  const now = Date.now();
  for (const key of await store.listKeys(workspace.id)) {
    if (key.revoked_at === null) await store.saveKey({ ...key, revoked_at: now });
  }
  for (const inv of await store.listInvitations(workspace.id)) {
    if (inv.accepted_at === null && inv.revoked_at === null) await store.saveInvitation({ ...inv, revoked_at: now });
  }
  for (const m of await store.listMembers(workspace.id)) {
    await store.deleteMember(workspace.id, m.sub);
    forgetMemberships(m.sub);
  }
  await store.deleteTenant(workspace);
  forgetProjects(workspace.id);
  // Its Query page user; nothing routes to a deleted workspace any more, so a failure here only leaves it unused.
  dropQueryUser({ id: workspace.id, shardId: workspace.shard_id }).catch((err) =>
    console.warn(`Could not drop the query user of workspace ${workspace.id}: ${err instanceof Error ? err.message : err}`),
  );
}

export const presentWorkspace = (w: TenantRecord, role: MemberRole) => ({
  id: w.id,
  slug: w.slug,
  name: w.name,
  role,
  default: w.id === DEFAULT_TENANT,
  created_at: new Date(w.created_at).toISOString(),
});
