import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../auth/user.js';
import { clearTenantCacheForTests, tenantContext, tenantOf } from './context.js';
import { clearMemberCacheForTests, personalTenantId, tenantIdForUser, userTenantResolver } from './members.js';
import { memoryTenancyStore, setTenancyStore, type TenancyStore } from './store.js';
import { createTenant, ensureDefaultTenant } from './tenants.js';

let store: TenancyStore;

const erin: AuthUser = { sub: 'idn_erin', issuer: 'https://auth.example.test', email: 'erin@example.com', clientId: 'ivy', agent: null };

beforeEach(async () => {
  store = memoryTenancyStore();
  setTenancyStore(store);
  clearMemberCacheForTests();
  clearTenantCacheForTests();
  await ensureDefaultTenant(undefined);
  vi.stubEnv('IVY_SINGLE_TENANT', '0');
});

afterEach(() => vi.unstubAllEnvs());

describe('personalTenantId', () => {
  it('is a stable tenant ID derived from the subject', () => {
    expect(personalTenantId('idn_erin')).toMatch(/^ten_[0-9A-Za-z]{21}$/);
    expect(personalTenantId('idn_erin')).toBe(personalTenantId('idn_erin'));
    expect(personalTenantId('idn_erin')).not.toBe(personalTenantId('idn_other'));
  });
});

describe('tenantIdForUser', () => {
  it('creates a tenant for a new user, named after their email, with them as owner', async () => {
    const id = await tenantIdForUser(erin);
    expect(id).toBe(personalTenantId('idn_erin'));
    expect((await store.getTenant(id))?.name).toBe('erin@example.com');
    expect(await store.findMemberships('idn_erin')).toMatchObject([{ tenant_id: id, role: 'owner', email: 'erin@example.com' }]);
  });

  it('returns the existing membership on later requests', async () => {
    const acme = await createTenant('Acme');
    await store.saveMember({ tenant_id: acme.id, sub: 'idn_erin', email: '', role: 'member', created_at: 1 });
    expect(await tenantIdForUser(erin)).toBe(acme.id);
    expect(await store.listTenants()).toHaveLength(2);
  });

  it('maps an agent to its user’s tenant', async () => {
    const id = await tenantIdForUser(erin);
    clearMemberCacheForTests();
    const agent = { ...erin, email: undefined, clientId: 'agt_ivy_x', agent: { clientId: 'agt_ivy_x', name: 'Claude Code' } };
    expect(await tenantIdForUser(agent)).toBe(id);
  });

  it('creates one tenant for concurrent first requests', async () => {
    const ids = await Promise.all([tenantIdForUser(erin), tenantIdForUser(erin), tenantIdForUser(erin)]);
    expect(new Set(ids).size).toBe(1);
    expect((await store.listTenants()).filter((t) => t.id !== 'default')).toHaveLength(1);
    expect(await store.findMemberships('idn_erin')).toHaveLength(1);
  });

  it('converges across processes (no shared in-memory state)', async () => {
    const first = tenantIdForUser(erin);
    clearMemberCacheForTests();
    const second = tenantIdForUser(erin);
    expect(await first).toBe(await second);
    expect((await store.listTenants()).filter((t) => t.id !== 'default')).toHaveLength(1);
    expect(await store.findMemberships('idn_erin')).toHaveLength(1);
  });

  it('maps everyone to default in single-tenant mode, which is the default', async () => {
    vi.stubEnv('IVY_SINGLE_TENANT', '');
    expect(await tenantIdForUser(erin)).toBe('default');
    vi.stubEnv('IVY_SINGLE_TENANT', '1');
    expect(await tenantIdForUser(erin)).toBe('default');
    expect(await store.listTenants()).toHaveLength(1);
  });
});

describe('userTenantResolver', () => {
  const appFor = (user: AuthUser | null) => {
    const app = new Hono();
    app.use(async (c, next) => {
      if (user) c.set('authUser', user);
      await next();
    });
    app.use(tenantContext(userTenantResolver()));
    app.get('/', (c) => c.json(tenantOf(c)));
    app.onError((err, c) => c.json({ error: err.message }, 401));
    return app;
  };

  it('uses default with auth off', async () => {
    vi.stubEnv('IVY_OIDC_ISSUER', '');
    expect(await (await appFor(null).request('/')).json()).toEqual({ id: 'default', shardId: 'shard-1' });
  });

  it('uses the user’s tenant with auth on', async () => {
    vi.stubEnv('IVY_OIDC_ISSUER', 'https://auth.example.test');
    vi.stubEnv('IVY_OIDC_CLIENT_ID', 'ivy');
    expect(await (await appFor(erin).request('/')).json()).toEqual({ id: personalTenantId('idn_erin'), shardId: 'shard-1' });
    expect((await appFor(null).request('/')).status).toBe(401);
  });
});
