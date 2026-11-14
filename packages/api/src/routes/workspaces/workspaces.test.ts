import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { startTestIssuer, type TestUser } from '../../lib/auth/testing.js';
import { memoryStore } from '../../lib/aws/memory-store.js';
import { setAwsStore } from '../../lib/aws/store.js';
import { type Email, setEmailSenderForTests } from '../../lib/email/send.js';
import { personalTenantId } from '../../lib/tenancy/members.js';
import type { TenancyStore } from '../../lib/tenancy/store.js';
import { resetTenancyForTests } from '../../lib/tenancy/testing.js';

const app = createApp({ uiDir: '/nonexistent' });
let issuer: Awaited<ReturnType<typeof startTestIssuer>>;
let store: TenancyStore;

const owner: TestUser = { sub: 'idn_owner', email: 'owner@example.com', email_verified: true };
const erin: TestUser = { sub: 'idn_erin', email: 'Erin@Example.com', email_verified: true };
const mallory: TestUser = { sub: 'idn_mallory', email: 'mallory@example.com', email_verified: true };

async function call(user: TestUser, method: string, path: string, body?: unknown, options?: Parameters<typeof issuer.token>[1]) {
  const headers: Record<string, string> = { ...(await issuer.auth(user, options)), origin: 'https://ivy.example.test' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  issuer = await startTestIssuer();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setEmailSenderForTests(undefined);
});

beforeEach(async () => {
  store = await resetTenancyForTests();
  setAwsStore(memoryStore().store);
  vi.stubEnv('IVY_SMTP_URL', '');
  vi.stubEnv('IVY_PUBLIC_URL', '');
});

/** Owner creates "Acme" and invites `email`; returns the invite token. */
async function acmeWithInvite(email = 'erin@example.com', role = 'member') {
  await call(owner, 'POST', '/api/workspaces', { name: 'Acme', slug: 'acme' });
  const { body } = await call(owner, 'POST', '/api/w/acme/invitations', { email, role });
  return (body.url as string).split('/invite/')[1];
}

describe('workspaces', () => {
  it('gives a new user a personal workspace, and lists only their own', async () => {
    const { body } = await call(erin, 'GET', '/api/workspaces');
    expect(body.items).toEqual([expect.objectContaining({ id: personalTenantId('idn_erin'), slug: 'erin', role: 'owner' })]);
    await call(owner, 'POST', '/api/workspaces', { name: 'Acme', slug: 'acme' });
    const mine = await call(erin, 'GET', '/api/workspaces');
    expect(mine.body.items.map((w: { slug: string }) => w.slug)).toEqual(['erin']);
  });

  it('creates a workspace with a default project, and rejects taken slugs', async () => {
    const created = await call(owner, 'POST', '/api/workspaces', { name: 'Acme', slug: 'acme' });
    expect(created).toMatchObject({ status: 201, body: { slug: 'acme', role: 'owner' } });
    expect((await call(owner, 'GET', '/api/w/acme/projects')).body.items).toMatchObject([{ slug: 'default', default: true }]);
    expect((await call(erin, 'POST', '/api/workspaces', { name: 'Other', slug: 'acme' })).status).toBe(409);
    expect((await call(erin, 'POST', '/api/workspaces', { name: 'Other', slug: 'default' })).status).toBe(409);
    expect((await call(erin, 'POST', '/api/workspaces', { name: 'Other', slug: 'Not A Slug' })).status).toBe(400);
  });

  it('answers 404 to non-members, the same as for a missing workspace', async () => {
    await call(owner, 'POST', '/api/workspaces', { name: 'Acme', slug: 'acme' });
    const acme = (await store.findTenantBySlug('acme'))!;
    for (const path of ['/api/w/acme', `/api/w/${acme.id}`, '/api/w/acme/p/default/functions', '/api/w/acme/members', '/api/w/acme/aws/accounts', '/api/w/default/projects']) {
      expect(await call(mallory, 'GET', path)).toEqual({ status: 404, body: { error: 'Workspace not found' } });
    }
    expect((await call(mallory, 'GET', '/api/w/nope')).status).toBe(404);
    expect((await call(owner, 'GET', '/api/w/acme')).body).toMatchObject({ slug: 'acme', role: 'owner' });
  });

  it('lets owners rename and delete (with confirmation), not members', async () => {
    const token = await acmeWithInvite();
    await call(erin, 'POST', `/api/invitations/${token}/accept`);
    expect((await call(erin, 'PATCH', '/api/w/acme', { name: 'Nope' })).status).toBe(403);
    expect((await call(erin, 'DELETE', '/api/w/acme?confirm=acme')).status).toBe(403);
    expect((await call(erin, 'POST', '/api/w/acme/invitations', { email: 'x@example.com' })).status).toBe(403);
    // Members can still work with projects.
    expect((await call(erin, 'POST', '/api/w/acme/projects', { name: 'Checkout (prod)' })).body).toMatchObject({ slug: 'checkout-prod' });

    expect((await call(owner, 'PATCH', '/api/w/acme', { name: 'Acme Inc', slug: 'acme-inc' })).body).toMatchObject({ name: 'Acme Inc', slug: 'acme-inc' });
    expect((await call(owner, 'DELETE', '/api/w/acme-inc')).status).toBe(400);
    expect((await call(owner, 'DELETE', '/api/w/acme-inc?confirm=acme')).status).toBe(400);
    expect((await call(owner, 'DELETE', '/api/w/acme-inc?confirm=acme-inc')).body).toEqual({ deleted: true });
    expect((await call(owner, 'GET', '/api/w/acme-inc')).status).toBe(404);
    expect((await call(erin, 'GET', '/api/workspaces')).body.items.map((w: { slug: string }) => w.slug)).toEqual(['erin']);
  });
});

describe('members and roles', () => {
  it('keeps at least one owner', async () => {
    const token = await acmeWithInvite();
    await call(erin, 'POST', `/api/invitations/${token}/accept`);
    const members = (await call(owner, 'GET', '/api/w/acme/members')).body.items;
    expect(members).toMatchObject([
      { sub: 'idn_owner', role: 'owner', you: true },
      { sub: 'idn_erin', role: 'member', email: 'Erin@Example.com' },
    ]);
    expect((await call(owner, 'PATCH', '/api/w/acme/members/idn_owner', { role: 'member' })).status).toBe(409);
    expect((await call(owner, 'DELETE', '/api/w/acme/members/idn_owner')).status).toBe(409);
    expect((await call(erin, 'PATCH', '/api/w/acme/members/idn_erin', { role: 'owner' })).status).toBe(403);
    expect((await call(erin, 'DELETE', '/api/w/acme/members/idn_owner')).status).toBe(403);

    expect((await call(owner, 'PATCH', '/api/w/acme/members/idn_erin', { role: 'owner' })).body.role).toBe('owner');
    expect((await call(owner, 'DELETE', '/api/w/acme/members/idn_owner')).body).toEqual({ removed: true });
    expect((await call(owner, 'GET', '/api/w/acme')).status).toBe(404);
    expect((await call(erin, 'DELETE', '/api/w/acme/members/idn_erin')).status).toBe(409);
  });
});

describe('invitations', () => {
  it('creates a link, emails it when SMTP is configured, and accepts it once', async () => {
    const sent: Email[] = [];
    setEmailSenderForTests(async (e) => void sent.push(e));
    vi.stubEnv('IVY_SMTP_URL', 'smtp://localhost:2525');
    vi.stubEnv('IVY_EMAIL_FROM', 'Ivy <noreply@example.com>');
    await call(owner, 'POST', '/api/workspaces', { name: 'Acme', slug: 'acme' });
    const created = await call(owner, 'POST', '/api/w/acme/invitations', { email: ' Erin@example.com ' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ invitation: { email: 'erin@example.com', role: 'member', status: 'pending' }, email_sent: true });
    expect(created.body.url).toMatch(/^https:\/\/ivy\.example\.test\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('erin@example.com');
    expect(sent[0].text).toContain(created.body.url);
    const token = created.body.url.split('/invite/')[1];
    expect(JSON.stringify(await store.listInvitations((await store.findTenantBySlug('acme'))!.id))).not.toContain(token);

    expect((await call(erin, 'GET', `/api/invitations/${token}`)).body).toMatchObject({ workspace: { slug: 'acme', name: 'Acme' }, status: 'pending' });
    const accepted = await call(erin, 'POST', `/api/invitations/${token}/accept`);
    expect(accepted.body).toMatchObject({ accepted: true, workspace: { slug: 'acme', role: 'member' } });
    expect((await call(erin, 'GET', '/api/w/acme')).status).toBe(200);

    const reused = await call(erin, 'POST', `/api/invitations/${token}/accept`);
    expect(reused).toEqual({ status: 410, body: { error: 'This invitation has already been used' } });
    expect((await call(owner, 'GET', '/api/w/acme/invitations')).body.items).toEqual([]);
  });

  it('refuses another email address', async () => {
    const token = await acmeWithInvite();
    const res = await call(mallory, 'POST', `/api/invitations/${token}/accept`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('This invitation is for erin@example.com');
    expect((await call(mallory, 'GET', '/api/w/acme')).status).toBe(404);
  });

  it('refuses an email the provider has not verified, checking userinfo when the token lacks the claims', async () => {
    const token = await acmeWithInvite();
    const unverified = await call({ ...erin, email_verified: false }, 'POST', `/api/invitations/${token}/accept`);
    expect(unverified.status).toBe(403);
    expect(unverified.body.error).toContain('hasn’t verified'.replace('’', "'"));

    // An access token without email claims (some providers issue these): the userinfo endpoint decides.
    const bare = { sub: 'idn_erin' };
    const noInfo = await call(bare, 'POST', `/api/invitations/${token}/accept`, undefined, { userinfo: { sub: 'idn_erin', email: 'erin@example.com', email_verified: false } });
    expect(noInfo.status).toBe(403);
    const ok = await call(bare, 'POST', `/api/invitations/${token}/accept`, undefined, { userinfo: { sub: 'idn_erin', email: 'erin@example.com', email_verified: true } });
    expect(ok.body.accepted).toBe(true);
  });

  it('refuses expired, revoked and unknown links', async () => {
    const token = await acmeWithInvite();
    vi.useFakeTimers({ now: Date.now() + 7 * 24 * 3600_000 + 1000, toFake: ['Date'] });
    try {
      expect(await call(erin, 'POST', `/api/invitations/${token}/accept`)).toEqual({
        status: 410,
        body: { error: 'This invitation has expired; ask for a new one' },
      });
    } finally {
      vi.useRealTimers();
    }

    const second = (await call(owner, 'POST', '/api/w/acme/invitations', { email: 'erin@example.com' })).body;
    expect((await call(owner, 'DELETE', `/api/w/acme/invitations/${second.invitation.id}`)).body.status).toBe('revoked');
    const revoked = await call(erin, 'POST', `/api/invitations/${second.url.split('/invite/')[1]}/accept`);
    expect(revoked.status).toBe(410);
    expect((await call(erin, 'POST', '/api/invitations/not-a-token/accept')).status).toBe(404);
  });

  it('replaces a pending invitation for the same email and refuses existing members', async () => {
    const first = await acmeWithInvite();
    await call(owner, 'POST', '/api/w/acme/invitations', { email: 'erin@example.com' });
    expect((await call(erin, 'POST', `/api/invitations/${first}/accept`)).status).toBe(410);
    expect((await call(owner, 'POST', '/api/w/acme/invitations', { email: 'owner@example.com' })).status).toBe(409);
    expect((await call(owner, 'POST', '/api/w/acme/invitations', { email: 'nope' })).status).toBe(400);
  });
});

describe('single-workspace mode', () => {
  it('has only the default workspace and no member management', async () => {
    vi.stubEnv('IVY_SINGLE_TENANT', '1');
    try {
      expect((await call(erin, 'GET', '/api/workspaces')).body.items).toMatchObject([{ slug: 'default', role: 'owner' }]);
      expect((await call(erin, 'POST', '/api/workspaces', { name: 'X' })).status).toBe(403);
      expect((await call(erin, 'GET', '/api/w/default/members')).status).toBe(403);
      expect((await call(erin, 'POST', '/api/w/default/invitations', { email: 'a@b.co' })).status).toBe(403);
      expect((await call(erin, 'PATCH', '/api/w/default', { name: 'Our Ivy' })).body.name).toBe('Our Ivy');
      expect((await call(erin, 'PATCH', '/api/w/default', { slug: 'ours' })).status).toBe(409);
      expect((await call(erin, 'GET', '/api/w/other')).status).toBe(404);
    } finally {
      vi.stubEnv('IVY_SINGLE_TENANT', '0');
    }
  });
});
