import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { startTestIssuer, type TestUser } from '../../lib/auth/testing.js';
import { alertStore, memoryAlertStore, setAlertStore } from '../../lib/alerts/store.js';
import { sign } from '../../lib/alerts/signing.js';
import { startFakeSlack } from '../../lib/alerts/testing.js';
import { decrypt } from '../../lib/tenancy/secret-box.js';
import type { TenancyStore } from '../../lib/tenancy/store.js';
import { resetTenancyForTests, testProject } from '../../lib/tenancy/testing.js';

const app = createApp({ uiDir: '/nonexistent' });
const realFetch = globalThis.fetch;
let issuer: Awaited<ReturnType<typeof startTestIssuer>>;
let slack: Awaited<ReturnType<typeof startFakeSlack>>;
let store: TenancyStore;

const SECRET = 'alerts-test-secret';
const owner: TestUser = { sub: 'idn_owner', email: 'owner@example.com', email_verified: true };
const erin: TestUser = { sub: 'idn_erin', email: 'erin@example.com', email_verified: true };
const P = '/api/w/acme/p/default';

async function call(user: TestUser, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { ...(await issuer.auth(user)) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

function configureSlack() {
  vi.stubEnv('IVY_SLACK_CLIENT_ID', '123.456');
  vi.stubEnv('IVY_SLACK_CLIENT_SECRET', 'slack-client-secret');
  vi.stubEnv('IVY_PUBLIC_URL', 'https://ivy.example.test');
  vi.stubEnv('IVY_SECRET_KEY', SECRET);
  vi.stubEnv('IVY_SLACK_API_URL', slack.apiUrl);
}

/** "Add to Slack" as the owner: Slack's URL, the state and the cookie the browser keeps. */
async function startConnect(user = owner) {
  const res = await call(user, 'POST', `${P}/alerts/slack/connect`);
  const url = new URL(res.body.url);
  const cookie = /ivy_slack_oauth=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return { res, url, state: url.searchParams.get('state')!, cookie };
}

const configOf = async () => (await (await app.request('/api/config')).json()) as { alerts: unknown };

const callback = (query: string, cookie?: string) =>
  app.request(`/api/slack/oauth/callback?${query}`, { headers: cookie ? { cookie: `ivy_slack_oauth=${cookie}` } : {} });

beforeAll(async () => {
  slack = await startFakeSlack();
  issuer = await startTestIssuer();
  // The fake issuer stubs fetch; let requests to the fake Slack through.
  const issuerFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith(slack.base) ? realFetch(input, init) : issuerFetch(input, init),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await slack.close();
});

beforeEach(async () => {
  store = await resetTenancyForTests();
  setAlertStore(memoryAlertStore());
  slack.reset();
  for (const name of ['IVY_SLACK_CLIENT_ID', 'IVY_SLACK_CLIENT_SECRET', 'IVY_PUBLIC_URL', 'IVY_SECRET_KEY', 'IVY_SMTP_URL', 'IVY_EMAIL_FROM']) vi.stubEnv(name, '');
  await call(owner, 'POST', '/api/workspaces', { name: 'Acme', slug: 'acme' });
  await testProject((await store.findTenantBySlug('acme'))!.id);
  const acme = (await store.findTenantBySlug('acme'))!;
  await store.saveMember({ tenant_id: acme.id, sub: erin.sub, email: erin.email!, role: 'member', created_at: Date.now() });
});

describe('env gating', () => {
  it('reports Slack and the digest as off until their variables are set', async () => {
    expect((await configOf()).alerts).toEqual({ slack: false, email: false });
    const alerts = await call(owner, 'GET', `${P}/alerts`);
    expect(alerts.body.available).toEqual({ slack: false, missing: ['IVY_SLACK_CLIENT_ID', 'IVY_SLACK_CLIENT_SECRET', 'IVY_PUBLIC_URL', 'IVY_SECRET_KEY'] });
    expect((await call(owner, 'POST', `${P}/alerts/slack/connect`)).status).toBe(409);
    expect((await call(owner, 'GET', '/api/w/acme/digest')).body).toMatchObject({ available: false, missing: ['IVY_SMTP_URL', 'IVY_EMAIL_FROM', 'IVY_PUBLIC_URL'] });

    configureSlack();
    expect((await configOf()).alerts).toEqual({ slack: true, email: false });
    vi.stubEnv('IVY_SMTP_URL', 'smtp://127.0.0.1:1');
    vi.stubEnv('IVY_EMAIL_FROM', 'Ivy <noreply@example.com>');
    expect((await configOf()).alerts).toEqual({ slack: true, email: true });
    // Slack also needs the public URL and the secret key.
    vi.stubEnv('IVY_SECRET_KEY', '');
    expect((await configOf()).alerts).toEqual({ slack: false, email: true });
  });
});

describe('alert settings', () => {
  it('has defaults, and only owners change them', async () => {
    expect((await call(erin, 'GET', `${P}/alerts`)).body).toMatchObject({
      can_edit: false,
      settings: { slack_enabled: true, interval_minutes: 60, every_occurrences: 100, include_throttles: false },
      integrations: [],
    });
    expect((await call(erin, 'PUT', `${P}/alerts`, { interval_minutes: 5 })).status).toBe(403);
    const saved = await call(owner, 'PUT', `${P}/alerts`, { interval_minutes: 15, every_occurrences: 10, include_throttles: true });
    expect(saved.body).toEqual({ slack_enabled: true, interval_minutes: 15, every_occurrences: 10, include_throttles: true });
    expect((await call(owner, 'PUT', `${P}/alerts`, { interval_minutes: 0 })).status).toBe(400);
    expect((await call(owner, 'PUT', `${P}/alerts`, { every_occurrences: 1.5 })).status).toBe(400);
    expect((await call(owner, 'PUT', `${P}/alerts`, { slack_enabled: 'no' })).status).toBe(400);
    expect((await call(owner, 'GET', `${P}/alerts`)).body.settings.interval_minutes).toBe(15);
  });
});

describe('Slack OAuth', () => {
  beforeEach(() => configureSlack());

  it('sends owners to Slack with only the incoming-webhook scope and a signed state', async () => {
    const { res, url, cookie } = await startConnect();
    expect(res.status).toBe(200);
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe('123.456');
    expect(url.searchParams.get('scope')).toBe('incoming-webhook');
    expect(url.searchParams.get('redirect_uri')).toBe('https://ivy.example.test/api/slack/oauth/callback');
    expect(cookie).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(res.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);
    expect((await call(erin, 'POST', `${P}/alerts/slack/connect`)).status).toBe(403);
  });

  it('stores the webhook encrypted and returns to the alert settings', async () => {
    const { state, cookie } = await startConnect();
    const res = await callback(`code=c0de&state=${encodeURIComponent(state)}`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://ivy.example.test/w/acme/settings/alerts/default?slack=connected');
    expect(slack.oauthCalls[0].get('code')).toBe('c0de');
    expect(slack.oauthCalls[0].get('client_secret')).toBe('slack-client-secret');
    expect(slack.oauthCalls[0].get('redirect_uri')).toBe('https://ivy.example.test/api/slack/oauth/callback');

    const acme = (await store.findTenantBySlug('acme'))!;
    const [row] = await alertStore().listIntegrations(acme.id, (await store.listProjects(acme.id))[0].id);
    expect(row).toMatchObject({ team_name: 'Acme', channel: '#alerts', channel_id: 'C0123', status: 'ok', created_by: owner.sub });
    expect(row.encrypted_webhook_url).not.toContain('hooks');
    expect(row.encrypted_webhook_url).toMatch(/^v1\./);
    expect(decrypt(row.encrypted_webhook_url, SECRET)).toBe(slack.hookUrl('main'));

    const listed = await call(erin, 'GET', `${P}/alerts`);
    expect(listed.body.integrations).toEqual([expect.objectContaining({ id: row.id, channel: '#alerts', team_name: 'Acme', status: 'ok' })]);
    expect(JSON.stringify(listed.body)).not.toContain('hooks/');

    // Connecting the same channel again replaces it; a second channel is added.
    const again = await startConnect();
    await callback(`code=c2&state=${encodeURIComponent(again.state)}`, again.cookie);
    expect((await call(owner, 'GET', `${P}/alerts`)).body.integrations).toHaveLength(1);
    slack.setOauthReply(() => ({ status: 200, body: JSON.stringify(slack.okOauth('second', '#ops', 'C0999')) }));
    const third = await startConnect();
    await callback(`code=c3&state=${encodeURIComponent(third.state)}`, third.cookie);
    expect((await call(owner, 'GET', `${P}/alerts`)).body.integrations.map((i: { channel: string }) => i.channel)).toEqual(['#alerts', '#ops']);
  });

  it('refuses a missing, forged or expired state, and a callback from another browser', async () => {
    const { state, cookie } = await startConnect();
    expect((await callback('code=x', cookie)).status).toBe(400);
    expect((await callback(`code=x&state=${encodeURIComponent(state)}x`, cookie)).status).toBe(400);
    const acme = (await store.findTenantBySlug('acme'))!;
    const forged = sign({ w: acme.id, p: 'prj_x', u: owner.sub, n: cookie, exp: Date.now() + 60_000 }, 'other-secret', 'slack-oauth-state');
    expect((await callback(`code=x&state=${encodeURIComponent(forged)}`, cookie)).status).toBe(400);
    const expired = sign({ w: acme.id, p: 'prj_x', u: owner.sub, n: cookie, exp: Date.now() - 1 }, SECRET, 'slack-oauth-state');
    expect((await callback(`code=x&state=${encodeURIComponent(expired)}`, cookie)).status).toBe(400);
    const noCookie = await callback(`code=x&state=${encodeURIComponent(state)}`);
    expect(noCookie.status).toBe(400);
    expect(await noCookie.text()).toContain('another browser');
    expect(slack.oauthCalls).toHaveLength(0);
  });

  it('returns errors to the settings page: cancelled, Slack refusing the code, no longer an owner', async () => {
    let flow = await startConnect();
    let res = await callback(`error=access_denied&state=${encodeURIComponent(flow.state)}`, flow.cookie);
    expect(res.headers.get('location')).toContain('?slack=denied');

    slack.setOauthReply(() => ({ status: 200, body: JSON.stringify({ ok: false, error: 'invalid_code' }) }));
    flow = await startConnect();
    res = await callback(`code=bad&state=${encodeURIComponent(flow.state)}`, flow.cookie);
    expect(new URL(res.headers.get('location')!).searchParams.get('slack')).toBe('error');
    expect(new URL(res.headers.get('location')!).searchParams.get('message')).toContain('invalid_code');

    slack.reset();
    flow = await startConnect();
    const acme = (await store.findTenantBySlug('acme'))!;
    await store.saveMember({ tenant_id: acme.id, sub: owner.sub, email: owner.email!, role: 'member', created_at: Date.now() });
    await store.saveMember({ tenant_id: acme.id, sub: erin.sub, email: erin.email!, role: 'owner', created_at: Date.now() });
    res = await callback(`code=c0de&state=${encodeURIComponent(flow.state)}`, flow.cookie);
    expect(new URL(res.headers.get('location')!).searchParams.get('message')).toBe('Only workspace owners can connect Slack');
    expect(slack.oauthCalls).toHaveLength(0);
  });

  it('sends a test message, and removes a channel', async () => {
    const flow = await startConnect();
    await callback(`code=c0de&state=${encodeURIComponent(flow.state)}`, flow.cookie);
    const [channel] = (await call(owner, 'GET', `${P}/alerts`)).body.integrations;
    const test = await call(owner, 'POST', `${P}/alerts/slack/${channel.id}/test`);
    expect(test.body).toMatchObject({ ok: true, error: null });
    expect(slack.posts[0].body.text).toContain('Test message from Ivy');

    slack.queue('main', { status: 403, body: 'invalid_token' });
    const broken = await call(owner, 'POST', `${P}/alerts/slack/${channel.id}/test`);
    expect(broken.body).toMatchObject({ ok: false, integration: { status: 'broken', error: 'HTTP 403 invalid_token' } });
    expect((await call(owner, 'GET', `${P}/alerts`)).body.integrations[0].status).toBe('broken');

    expect((await call(erin, 'DELETE', `${P}/alerts/slack/${channel.id}`)).status).toBe(403);
    expect((await call(owner, 'DELETE', `${P}/alerts/slack/${channel.id}`)).body).toEqual({ removed: true });
    expect((await call(owner, 'GET', `${P}/alerts`)).body.integrations).toEqual([]);
    expect((await call(owner, 'DELETE', `${P}/alerts/slack/${channel.id}`)).status).toBe(404);
  });
});
