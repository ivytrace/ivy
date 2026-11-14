import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { readAuthConfig } from '../auth/config.js';
import { authUser, type AuthUser } from '../auth/user.js';
import { lookupTenant, type TenantResolver } from './context.js';
import { DEFAULT_SHARD } from './shards.js';
import { tenancyStore } from './store.js';
import { createTenant, DEFAULT_TENANT } from './tenants.js';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * The tenant ID a user's own tenant gets: `ten_` + 21 base62 characters of sha256(sub). Deterministic,
 * so concurrent first requests (in one process or several) create the same tenant and membership rows,
 * which the ReplacingMergeTree tables collapse.
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

const TTL_MS = 60_000;
const cache = new Map<string, { tenantId: string; expires: number }>();
const pending = new Map<string, Promise<string>>();

async function findOrCreate(user: AuthUser): Promise<string> {
  const store = tenancyStore();
  const [first] = await store.findMemberships(user.sub);
  if (first) return first.tenant_id;

  const id = personalTenantId(user.sub);
  if (!(await store.getTenant(id))) await createTenant(user.email || user.name || user.sub, DEFAULT_SHARD, id);
  await store.saveMember({ tenant_id: id, sub: user.sub, email: user.email ?? '', role: 'owner', created_at: Date.now() });
  return id;
}

/**
 * The tenant a signed-in user (or an agent acting for them, same `sub`) works in: their oldest
 * membership, or a new tenant of their own on their first request.
 */
export async function tenantIdForUser(user: AuthUser): Promise<string> {
  if (singleTenantMode()) return DEFAULT_TENANT;
  const hit = cache.get(user.sub);
  if (hit && hit.expires > Date.now()) return hit.tenantId;

  let lookup = pending.get(user.sub);
  if (!lookup) {
    lookup = findOrCreate(user).finally(() => pending.delete(user.sub));
    pending.set(user.sub, lookup);
  }
  const tenantId = await lookup;
  cache.set(user.sub, { tenantId, expires: Date.now() + TTL_MS });
  return tenantId;
}

export function clearMemberCacheForTests() {
  cache.clear();
  pending.clear();
}

/** `default` with auth off; with OIDC on, the signed-in user's tenant (401 without a user). */
export const userTenantResolver = (): TenantResolver => ({
  async resolve(c: Context) {
    if (!readAuthConfig()) return lookupTenant(DEFAULT_TENANT);
    const user = authUser(c);
    return user ? lookupTenant(await tenantIdForUser(user)) : null;
  },
});
