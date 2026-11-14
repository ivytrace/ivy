import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readAuthConfig } from '../auth/config.js';
import { rememberDefaultUser } from '../alerts/prefs.js';
import { notify } from '../hooks/run.js';
import { authUser, type AuthUser } from '../auth/user.js';
import type { Membership, WorkspaceAccess } from './context.js';
import { DEFAULT_SHARD } from './shards.js';
import { tenancyStore, type MemberRecord, type MemberRole, type TenantRecord } from './store.js';
import { createTenant, DEFAULT_TENANT } from './tenants.js';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * The ID a user's personal workspace gets: `ten_` + 21 base62 characters of sha256(sub).
 * Deterministic, so concurrent first requests (in one process or several) create the same tenant
 * and membership rows, which the ReplacingMergeTree tables collapse.
 */
export function personalTenantId(sub: string): string {
  let n = BigInt(`0x${createHash('sha256').update(`ivy-tenant:${sub}`, 'utf8').digest('hex')}`);
  let out = '';
  for (let i = 0; i < 21; i++) {
    out += ALPHABET[Number(n % 62n)];
    n /= 62n;
  }
  return `ten_${out}`;
}

/**
 * Self-hosted installs are one tenant: every signed-in user maps to `default`. Hosted sets
 * IVY_SINGLE_TENANT=0 to give each new user a tenant of their own.
 */
export const singleTenantMode = (env: NodeJS.ProcessEnv = process.env) => !['0', 'false'].includes(env.IVY_SINGLE_TENANT?.trim() ?? '');

/**
 * Workspaces are real (several per install, members, invitations) only with OIDC on and
 * IVY_SINGLE_TENANT=0. Otherwise there is one workspace, `default`, and everyone owns it.
 */
export const multiWorkspaceMode = () => !!readAuthConfig() && !singleTenantMode();

/** 403 for workspace/member management that only exists in multi-workspace mode. */
export function requireMultiWorkspace(what: string) {
  if (!multiWorkspaceMode()) {
    throw new HTTPException(403, {
      message: `${what} needs sign-in with IVY_SINGLE_TENANT=0; this install has a single workspace (default)`,
    });
  }
}

const TTL_MS = 5_000;
const cache = new Map<string, { members: MemberRecord[]; expires: number }>();
const pending = new Map<string, Promise<MemberRecord[]>>();

/** The caller's memberships, cached for a few seconds (in-process changes clear it). */
async function membershipsOf(sub: string): Promise<MemberRecord[]> {
  const hit = cache.get(sub);
  if (hit && hit.expires > Date.now()) return hit.members;
  let lookup = pending.get(sub);
  if (!lookup) {
    lookup = tenancyStore()
      .findMemberships(sub)
      .finally(() => pending.delete(sub));
    pending.set(sub, lookup);
  }
  const members = await lookup;
  cache.set(sub, { members, expires: Date.now() + TTL_MS });
  return members;
}

export function forgetMemberships(sub?: string) {
  if (sub) cache.delete(sub);
  else cache.clear();
  if (!sub) pending.clear();
}

export const clearMemberCacheForTests = () => forgetMemberships();

const creating = new Map<string, Promise<void>>();

/** A user's first workspace, created on their first request: named after them, with them as owner. */
async function ensurePersonalWorkspace(user: AuthUser): Promise<void> {
  let run = creating.get(user.sub);
  if (!run) {
    run = (async () => {
      const store = tenancyStore();
      const id = personalTenantId(user.sub);
      let created = null;
      if (!(await store.getTenant(id))) {
        const label = user.name || user.email?.split('@')[0] || 'personal';
        created = await createTenant(user.email || user.name || user.sub, DEFAULT_SHARD, id, undefined, label);
      }
      await store.saveMember({ tenant_id: id, sub: user.sub, email: user.email ?? '', role: 'owner', created_at: Date.now() });
      forgetMemberships(user.sub);
      if (created) {
        notify('on-workspace-created', {
          workspace: { id: created.id, slug: created.slug, name: created.name },
          owner: { sub: user.sub, email: user.email ?? null },
        });
      }
    })().finally(() => creating.delete(user.sub));
    creating.set(user.sub, run);
  }
  await run;
}

async function defaultMembership(): Promise<Membership> {
  const workspace = await tenancyStore().getTenant(DEFAULT_TENANT);
  if (!workspace) throw new Error('The default tenant is missing (ensureDefaultTenant runs at startup)');
  return { workspace, role: 'owner' };
}

const matches = (t: TenantRecord, ref: string) => t.id === ref || t.slug === ref;

/**
 * Single workspace (auth off, or IVY_SINGLE_TENANT unset/1): `default`, owned by everyone.
 * Multi-workspace: the signed-in user's memberships in `ivy_control.tenant_members`; a user with
 * none gets a personal workspace on their first request.
 */
export const userWorkspaceAccess = (): WorkspaceAccess => ({
  async list(c: Context) {
    if (!multiWorkspaceMode()) {
      void rememberDefaultUser(authUser(c));
      return [await defaultMembership()];
    }
    const user = authUser(c);
    if (!user) throw new HTTPException(401, { message: 'Authentication required' });
    let members = await membershipsOf(user.sub);
    if (!members.length) {
      await ensurePersonalWorkspace(user);
      members = await membershipsOf(user.sub);
    }
    const store = tenancyStore();
    const out: Membership[] = [];
    for (const m of members) {
      const workspace = await store.getTenant(m.tenant_id);
      if (workspace) out.push({ workspace, role: m.role });
    }
    return out;
  },
  async find(c: Context, ref: string) {
    if (!multiWorkspaceMode()) {
      const membership = await defaultMembership();
      return matches(membership.workspace, ref) ? membership : null;
    }
    const user = authUser(c);
    if (!user) return null;
    const store = tenancyStore();
    const workspace = ref.startsWith('ten_') || ref === DEFAULT_TENANT ? await store.getTenant(ref) : await store.findTenantBySlug(ref);
    if (!workspace) return null;
    const member = (await membershipsOf(user.sub)).find((m) => m.tenant_id === workspace.id);
    return member ? { workspace, role: member.role } : null;
  },
});

/** Fixed access for tests: one workspace with the given role. */
export const fixedWorkspaceAccess = (workspace: TenantRecord, role: MemberRole = 'owner'): WorkspaceAccess => ({
  list: async () => [{ workspace, role }],
  find: async (_c, ref) => (matches(workspace, ref) ? { workspace, role } : null),
});

const ownersOf = (members: MemberRecord[]) => members.filter((m) => m.role === 'owner');

async function loadMember(tenantId: string, sub: string): Promise<{ member: MemberRecord; members: MemberRecord[] }> {
  const members = await tenancyStore().listMembers(tenantId);
  const member = members.find((m) => m.sub === sub);
  if (!member) throw new HTTPException(404, { message: 'Member not found' });
  return { member, members };
}

/** Changes a member's role. A workspace always keeps at least one owner. */
export async function setMemberRole(tenantId: string, sub: string, input: unknown): Promise<MemberRecord> {
  const role = input as MemberRole;
  if (role !== 'owner' && role !== 'member') throw new HTTPException(400, { message: 'role must be "owner" or "member"' });
  const { member, members } = await loadMember(tenantId, sub);
  if (member.role === 'owner' && role === 'member' && ownersOf(members).length === 1) {
    throw new HTTPException(409, { message: 'The last owner can’t become a member; make someone else an owner first' });
  }
  const next = { ...member, role };
  await tenancyStore().saveMember(next);
  forgetMemberships(sub);
  return next;
}

/** Removes a member (or lets one leave). The last owner can't leave. */
export async function removeMember(tenantId: string, sub: string): Promise<void> {
  const { member, members } = await loadMember(tenantId, sub);
  if (member.role === 'owner' && ownersOf(members).length === 1) {
    throw new HTTPException(409, { message: 'The last owner can’t leave; make someone else an owner first, or delete the workspace' });
  }
  await tenancyStore().deleteMember(tenantId, sub);
  forgetMemberships(sub);
}

export const presentMember = (m: MemberRecord, me: string | null) => ({
  sub: m.sub,
  email: m.email || null,
  role: m.role,
  you: m.sub === me,
  joined_at: new Date(m.created_at).toISOString(),
});
