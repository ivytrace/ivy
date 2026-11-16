import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { startTestIssuer, type TestUser } from '../../lib/auth/testing.js';
import { alertStore, memoryAlertStore, setAlertStore } from '../../lib/alerts/store.js';
import { setAlertDataForTests } from '../../lib/alerts/data.js';
import { evaluateAlerts } from '../../lib/alerts/evaluate.js';
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

describe('apply to other projects', () => {
  const rule = { slack_enabled: false, interval_minutes: 15, every_occurrences: 10, include_throttles: true };
  const W = '/api/w/acme';
  let DEFAULT: string;

  beforeEach(async () => {
    DEFAULT = (await store.listProjects((await store.findTenantBySlug('acme'))!.id))[0].id;
  });

  async function projectsOf(slug: string) {
    const tenant = (await store.findTenantBySlug(slug))!;
    const [checkout, billing, archived] = await Promise.all(
      ['Checkout', 'Billing', 'Old'].map((name) => call(owner, 'POST', `/api/w/${slug}/projects`, { name }).then((r) => r.body.id as string)),
    );
    await call(owner, 'PATCH', `/api/w/${slug}/p/${archived}`, { archived: true });
    return { tenant, checkout, billing, archived };
  }

  it('sets the whole rule on every listed project in one write, and leaves the others and the channels alone', async () => {
    const { tenant, checkout, billing } = await projectsOf('acme');
    const before = (await call(owner, 'GET', `${P}/alerts`)).body.settings;
    const res = await call(owner, 'POST', `${W}/alerts/apply`, { source: DEFAULT, projects: [checkout, billing, checkout], settings: rule });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updated: 2,
      projects: [expect.objectContaining({ id: checkout, name: 'Checkout' }), expect.objectContaining({ id: billing, name: 'Billing' })],
      settings: rule,
      channels_added: 0,
    });
    expect(await alertStore().getSettings(tenant.id, checkout)).toEqual(rule);
    expect(await alertStore().getSettings(tenant.id, billing)).toEqual(rule);
    expect((await call(owner, 'GET', `${P}/alerts`)).body.settings).toEqual(before);
    expect(await alertStore().listIntegrations(tenant.id, checkout)).toEqual([]);
  });

  it('is for owners only', async () => {
    const { tenant, checkout } = await projectsOf('acme');
    expect((await call(erin, 'POST', `${W}/alerts/apply`, { source: DEFAULT, projects: [checkout], settings: rule })).status).toBe(403);
    expect((await alertStore().getSettings(tenant.id, checkout)).interval_minutes).toBe(60);
  });

  it('writes nothing when a project is unknown, archived or in another workspace', async () => {
    const { tenant, checkout, archived } = await projectsOf('acme');
    const stranger: TestUser = { sub: 'idn_other', email: 'other@example.com', email_verified: true };
    await call(stranger, 'POST', '/api/workspaces', { name: 'Other', slug: 'other' });
    const foreign = (await call(stranger, 'POST', '/api/w/other/projects', { name: 'Theirs' })).body.id as string;

    for (const id of [foreign, archived, 'prj_missing']) {
      const res = await call(owner, 'POST', `${W}/alerts/apply`, { source: DEFAULT, projects: [checkout, id], settings: rule });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(id);
    }
    expect((await alertStore().getSettings(tenant.id, checkout)).interval_minutes).toBe(60);
    const other = (await store.findTenantBySlug('other'))!;
    expect((await alertStore().getSettings(other.id, foreign)).interval_minutes).toBe(60);
    // Not a member of the other workspace: the same 404 as a workspace that doesn't exist.
    expect((await call(owner, 'POST', '/api/w/other/alerts/apply', { source: foreign, projects: [foreign], settings: rule })).status).toBe(404);
  });

  it('validates the project list and requires the whole rule', async () => {
    const { checkout } = await projectsOf('acme');
    const apply = (body: Record<string, unknown>) => call(owner, 'POST', `${W}/alerts/apply`, { source: DEFAULT, ...body });
    expect((await apply({ projects: [], settings: rule })).status).toBe(400);
    expect((await apply({ projects: checkout, settings: rule })).status).toBe(400);
    expect((await apply({ projects: [42], settings: rule })).status).toBe(400);
    expect((await apply({ projects: Array.from({ length: 501 }, () => checkout), settings: rule })).status).toBe(400);
    expect((await apply({ projects: [checkout] })).body.error).toBe('settings must be an object');
    expect((await apply({ source: undefined, projects: [checkout], settings: rule })).body.error).toBe('source must be an active project of this workspace');
    expect((await apply({ source: 'prj_missing', projects: [checkout], settings: rule })).status).toBe(400);
    expect((await apply({ projects: [checkout], settings: { interval_minutes: 5 } })).body.error).toBe(
      'settings needs slack_enabled, every_occurrences, include_throttles',
    );
    expect((await apply({ projects: [checkout], settings: { ...rule, interval_minutes: 0 } })).status).toBe(400);
    expect((await apply({ projects: [checkout], settings: { ...rule, include_throttles: 'yes' } })).status).toBe(400);
  });
});

describe('apply to other projects: Slack channels', () => {
  const rule = { slack_enabled: true, interval_minutes: 60, every_occurrences: 100, include_throttles: false };
  const W = '/api/w/acme';
  let tenant: string;
  let source: string;
  let checkout: string;
  let billing: string;

  async function connectChannel(project: string, hook: string, channel: string, channelId: string) {
    slack.setOauthReply(() => ({ status: 200, body: JSON.stringify(slack.okOauth(hook, channel, channelId)) }));
    const res = await call(owner, 'POST', `/api/w/acme/p/${project}/alerts/slack/connect`);
    const state = new URL(res.body.url).searchParams.get('state')!;
    const cookie = /ivy_slack_oauth=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
    await callback(`code=c&state=${encodeURIComponent(state)}`, cookie);
  }

  beforeEach(async () => {
    configureSlack();
    tenant = (await store.findTenantBySlug('acme'))!.id;
    source = (await store.listProjects(tenant))[0].id;
    checkout = (await call(owner, 'POST', `${W}/projects`, { name: 'Checkout' })).body.id;
    billing = (await call(owner, 'POST', `${W}/projects`, { name: 'Billing' })).body.id;
    await connectChannel(source, 'main', '#alerts', 'C0123');
    await connectChannel(source, 'ops', '#ops', 'C0999');
  });

  const apply = (projects: string[]) => call(owner, 'POST', `${W}/alerts/apply`, { source, projects, settings: rule });
  const channelsOf = (project: string) => alertStore().listIntegrations(tenant, project);

  it('copies the working channels with the same webhook, connected now, and skips what a project already has', async () => {
    const originals = await channelsOf(source);
    const before = Date.now();
    const res = await apply([checkout, billing]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 2, channels_added: 4 });
    expect(res.body.projects.map((p: { channels_added: number }) => p.channels_added)).toEqual([2, 2]);

    const copies = await channelsOf(checkout);
    expect(copies.map((c) => c.channel)).toEqual(['#alerts', '#ops']);
    for (const copy of copies) {
      const original = originals.find((o) => o.channel_id === copy.channel_id)!;
      expect(copy.id).not.toBe(original.id);
      expect(decrypt(copy.encrypted_webhook_url, SECRET)).toBe(decrypt(original.encrypted_webhook_url, SECRET));
      expect(copy.created_at).toBeGreaterThanOrEqual(before);
      expect(copy.created_by).toBe(owner.sub);
    }
    expect(await channelsOf(source)).toEqual(originals);

    // Running it again adds nothing; nor does a target that connected the same Slack channel itself.
    expect((await apply([checkout, billing])).body.channels_added).toBe(0);
    const support = (await call(owner, 'POST', `${W}/projects`, { name: 'Support' })).body.id;
    await connectChannel(support, 'support-own', '#alerts', 'C0123');
    const third = await apply([support]);
    expect(third.body.channels_added).toBe(1);
    expect((await channelsOf(support)).map((c) => c.channel)).toEqual(['#alerts', '#ops']);
  });

  it("doesn't post the target project's existing error groups as new", async () => {
    const now = Date.now();
    const seen: string[] = [];
    setAlertDataForTests({
      async activeGroups(scope) {
        seen.push(scope.projectId!);
        return [{
          fingerprint: 'fp_old', function: 'checkout-createOrder', kind: 'error', error_type: 'TypeError',
          error_message: 'boom', error_template: 'boom', variants: 1, failure_kind: null, seen_before: false,
          sample_trace_id: null, total: 3, first_seen: now - 10 * 60_000, last_seen: now - 60_000, since_notify: 3,
        }];
      },
      stackLine: async () => null,
      digest: async () => { throw new Error('not used'); },
    });
    try {
      // The source's channels date from before the group: had the copy kept that date, the group would be "new".
      const old = (await channelsOf(source)).map((c) => ({ ...c, created_at: now - 60 * 60_000 }));
      await alertStore().saveIntegrations(old);
      await apply([checkout]);
      // Only checkout is evaluated against the fake data's group; the source gets nothing to send for it.
      await alertStore().saveIntegrations(await channelsOf(source), true);
      expect(await evaluateAlerts({ now })).toMatchObject({ messages: 0 });
      expect(seen).toEqual([checkout]);
      expect((await alertStore().listStates(tenant, checkout)).map((s) => s.fingerprint)).toEqual(['fp_old']);
      expect(slack.posts).toHaveLength(0);
    } finally {
      setAlertDataForTests(undefined);
    }
  });

  it('marks every copy broken when Slack rejects the webhook, and a successful test revives them', async () => {
    await apply([checkout]);
    const main = (await channelsOf(source)).find((c) => c.channel === '#alerts')!;
    slack.queue('main', { status: 404, body: 'channel_not_found' });
    expect((await call(owner, 'POST', `${P}/alerts/slack/${main.id}/test`)).body.ok).toBe(false);
    const status = async (project: string) => Object.fromEntries((await channelsOf(project)).map((c) => [c.channel, c.status]));
    expect(await status(source)).toEqual({ '#alerts': 'broken', '#ops': 'ok' });
    expect(await status(checkout)).toEqual({ '#alerts': 'broken', '#ops': 'ok' });

    expect((await call(owner, 'POST', `${P}/alerts/slack/${main.id}/test`)).body.ok).toBe(true);
    expect(await status(checkout)).toEqual({ '#alerts': 'ok', '#ops': 'ok' });
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
