import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../auth/user.js';
import { membershipOf, workspaceContext } from './context.js';
import { clearMemberCacheForTests, personalTenantId, userWorkspaceAccess } from './members.js';
import type { TenancyStore } from './store.js';
import { createTenant } from './tenants.js';
import { resetTenancyForTests } from './testing.js';

let store: TenancyStore;
const erin: AuthUser = { sub: 'idn_erin', issuer: 'https://auth.example.test', email: 'erin@example.com', clientId: 'ivy', agent: null };

beforeEach(async () => {
  store = await resetTenancyForTests();
  vi.stubEnv('IVY_OIDC_ISSUER', 'https://auth.example.test');
  vi.stubEnv('IVY_OIDC_CLIENT_ID', 'ivy');
  vi.stubEnv('IVY_SINGLE_TENANT', '0');
});
afterEach(() => vi.unstubAllEnvs());

function appFor(user: AuthUser | null) {
  const access = userWorkspaceAccess();
  const app = new Hono();
  app.use(async (c, next) => {
    if (user) c.set('authUser', user);
    await next();
  });
  app.get('/list', async (c) => c.json((await access.list(c)).map((m) => ({ id: m.workspace.id, role: m.role }))));
  app.use('/w/:workspace', workspaceContext(access));
  app.get('/w/:workspace', (c) => c.json({ id: membershipOf(c).workspace.id, role: membershipOf(c).role }));
  app.onError((err, c) => c.json({ error: err.message }, 'status' in err ? (err.status as 404) : 500));
  return app;
}

describe('personalTenantId', () => {
  it('is a stable tenant ID derived from the subject', () => {
    expect(personalTenantId('idn_erin')).toMatch(/^ten_[0-9A-Za-z]{21}$/);
    expect(personalTenantId('idn_erin')).toBe(personalTenantId('idn_erin'));
    expect(personalTenantId('idn_erin')).not.toBe(personalTenantId('idn_other'));
  });
});

describe('userWorkspaceAccess', () => {
  it('creates one personal workspace for concurrent first requests, also across processes', async () => {
    const app = appFor(erin);
    const lists = await Promise.all([app.request('/list'), app.request('/list'), appFor(erin).request('/list')]);
    clearMemberCacheForTests();
    const second = await (await appFor(erin).request('/list')).json();
    expect(second).toEqual([{ id: personalTenantId('idn_erin'), role: 'owner' }]);
    for (const res of lists) expect(await res.json()).toEqual(second);
    expect((await store.listTenants()).filter((t) => t.id !== 'default')).toHaveLength(1);
    expect(await store.findMemberships('idn_erin')).toHaveLength(1);
    expect((await store.getTenant(personalTenantId('idn_erin')))?.slug).toBe('erin');
  });

  it('maps an agent to its user’s workspaces', async () => {
    const acme = await createTenant('Acme', undefined, undefined, 'acme');
    await store.saveMember({ tenant_id: acme.id, sub: 'idn_erin', email: '', role: 'member', created_at: 1 });
    const agent = { ...erin, email: undefined, clientId: 'agt_ivy_x', agent: { clientId: 'agt_ivy_x', name: 'Claude Code' } };
    expect(await (await appFor(agent).request('/list')).json()).toEqual([{ id: acme.id, role: 'member' }]);
    expect(await (await appFor(agent).request('/w/acme')).json()).toEqual({ id: acme.id, role: 'member' });
  });

  it('finds workspaces by slug or ID for members only', async () => {
    const acme = await createTenant('Acme', undefined, undefined, 'acme');
    await store.saveMember({ tenant_id: acme.id, sub: 'idn_other', email: '', role: 'owner', created_at: 1 });
    expect((await appFor(erin).request('/w/acme')).status).toBe(404);
    expect((await appFor(erin).request(`/w/${acme.id}`)).status).toBe(404);
    expect((await appFor(erin).request('/w/default')).status).toBe(404);
    expect((await appFor(null).request('/w/acme')).status).toBe(404);
  });

  it('is the default workspace, owned by everyone, with auth off or in single-tenant mode', async () => {
    for (const env of [{ IVY_OIDC_ISSUER: '' }, { IVY_SINGLE_TENANT: '1' }, { IVY_SINGLE_TENANT: '' }]) {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      expect(await (await appFor(erin).request('/list')).json()).toEqual([{ id: 'default', role: 'owner' }]);
      expect(await (await appFor(null).request('/w/default')).json()).toEqual({ id: 'default', role: 'owner' });
      expect((await appFor(erin).request('/w/acme')).status).toBe(404);
    }
    expect(await store.listTenants()).toHaveLength(1);
  });
});
