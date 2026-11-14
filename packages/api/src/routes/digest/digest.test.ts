import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { startTestIssuer, type TestUser } from '../../lib/auth/testing.js';
import { setAlertDataForTests, type AlertDataSource, type DigestData } from '../../lib/alerts/data.js';
import {
  digestPeriod,
  digestRecipients,
  newUntracedFunctions,
  readUnsubscribeToken,
  resetDigestRunsForTests,
  sendDueDigests,
  unsubscribeToken,
} from '../../lib/alerts/digest.js';
import { memoryStore } from '../../lib/aws/memory-store.js';
import { setAwsStore } from '../../lib/aws/store.js';
import type { AwsAccount, FunctionStatus, TraceState } from '../../lib/aws/types.js';
import { alertStore, memoryAlertStore, setAlertStore } from '../../lib/alerts/store.js';
import { decodedMail, mailHeader, startSmtpCatcher } from '../../lib/email/testing.js';
import { derivedProjectId } from '../../lib/tenancy/ids.js';
import type { TenancyStore, TenantRecord } from '../../lib/tenancy/store.js';
import { resetTenancyForTests, testProject } from '../../lib/tenancy/testing.js';

const app = createApp({ uiDir: '/nonexistent' });
let issuer: Awaited<ReturnType<typeof startTestIssuer>>;
let smtp: Awaited<ReturnType<typeof startSmtpCatcher>>;
let store: TenancyStore;
let acme: TenantRecord;

const owner: TestUser = { sub: 'idn_owner', email: 'owner@example.com', email_verified: true };
const erin: TestUser = { sub: 'idn_erin', email: 'erin@example.com', email_verified: true };
/** Monday 16 November 2026, 08:00 UTC: the default schedule. */
const MONDAY = Date.UTC(2026, 10, 16, 8, 0);
const DAY = 86_400_000;

async function call(user: TestUser, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { ...(await issuer.auth(user)) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

let aws: ReturnType<typeof memoryStore>;

const awsAccount = (tenant: string, status: AwsAccount['status'] = 'connected'): AwsAccount => ({
  tenant_id: tenant,
  id: 'conn-1',
  name: 'Prod',
  account_id: '123456789012',
  role_arn: 'arn:aws:iam::123456789012:role/IvyTrace',
  external_id: 'ext',
  event_secret: 'secret',
  stack_name: 'ivy-trace',
  stack_region: 'eu-west-1',
  default_project_id: '',
  reviewed_at: 0,
  regions: ['eu-west-1'],
  all_regions: false,
  status,
  error: '',
  created_at: 1,
  verified_at: 1,
  last_sync_at: 1,
  throttle_metrics: false,
  throttle_status: '',
  throttles_polled_to: 0,
});

const lambdaFn = (tenant: string, name: string, firstSeen: number, state: TraceState = 'available', tags: Record<string, string> = {}): FunctionStatus => ({
  tenant_id: tenant,
  account_id: 'conn-1',
  region: 'eu-west-1',
  function_name: name,
  function_arn: `arn:aws:lambda:eu-west-1:123456789012:function:${name}`,
  runtime: 'nodejs22.x',
  state,
  reason: '',
  project_id: '',
  project_source: '',
  rule_id: '',
  stack: '',
  tags,
  last_modified: '',
  first_seen_at: firstSeen,
  updated_at: 1,
});

/** Per workspace ID: what the fake "ClickHouse" has for the week. */
let weeks: Map<string, DigestData>;

const fakeData: AlertDataSource = {
  activeGroups: async () => [],
  stackLine: async () => null,
  async digest(scope) {
    return weeks.get(scope.tenant.id) ?? { totals: zero, previous: zero, groups: [] };
  },
};
const zero = { invocations: 0, errors: 0, failures: 0, throttles: 0 };

function acmeWeek(): DigestData {
  const project = derivedProjectId(acme.id);
  const period = digestPeriod(MONDAY);
  return {
    totals: { invocations: 120_000, errors: 412, failures: 3, throttles: 17 },
    previous: { invocations: 100_000, errors: 206, failures: 0, throttles: 17 },
    groups: [
      {
        project_id: project,
        fingerprint: 'fp_old',
        function: 'checkout-createOrder',
        kind: 'error',
        error_type: 'TypeError',
        error_message: "Cannot read properties of undefined (reading 'id')",
        error_template: "Cannot read properties of undefined (reading 'id')",
        variants: 1,
        failure_kind: null,
        sample_trace_id: '673f1a2b0000000000000000000000aa',
        count: 400,
        previous: 200,
        first_seen: period.from - 20 * DAY,
      },
      {
        project_id: project,
        fingerprint: 'fp_new',
        function: 'orders-processQueue',
        kind: 'error',
        error_type: 'Runtime.OutOfMemory',
        error_message: 'Runtime exited with error: signal: killed <b>',
        error_template: 'Runtime exited with error: signal: killed <b>',
        variants: 1,
        failure_kind: 'out_of_memory',
        sample_trace_id: '673f1a2b0000000000000000000000bb',
        count: 12,
        previous: 0,
        first_seen: period.from + DAY,
      },
    ],
  };
}

beforeAll(async () => {
  issuer = await startTestIssuer();
  smtp = await startSmtpCatcher();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setAlertDataForTests(undefined);
  await smtp.close();
});

beforeEach(async () => {
  store = await resetTenancyForTests();
  setAlertStore(memoryAlertStore());
  setAlertDataForTests(fakeData);
  aws = memoryStore();
  setAwsStore(aws.store);
  resetDigestRunsForTests();
  smtp.messages.length = 0;
  vi.stubEnv('IVY_SMTP_URL', smtp.url);
  vi.stubEnv('IVY_EMAIL_FROM', 'Ivy <noreply@example.com>');
  vi.stubEnv('IVY_PUBLIC_URL', 'https://ivy.example.test');
  vi.stubEnv('IVY_SECRET_KEY', 'digest-test-secret');
  vi.stubEnv('IVY_DIGEST_CRON', '');
  vi.stubEnv('IVY_DIGEST_TO', '');
  await call(owner, 'POST', '/api/workspaces', { name: 'Acme', slug: 'acme' });
  await testProject((await store.findTenantBySlug('acme'))!.id);
  acme = (await store.findTenantBySlug('acme'))!;
  await store.saveMember({ tenant_id: acme.id, sub: erin.sub, email: erin.email!, role: 'member', created_at: Date.now() });
  weeks = new Map([[acme.id, acmeWeek()]]);
});

describe('weekly digest', () => {
  it('goes to every member on Monday 08:00 UTC, with the week’s content and an unsubscribe link', async () => {
    expect(await sendDueDigests(MONDAY - 60_000)).toMatchObject({ emails: 0 });
    expect(await sendDueDigests(MONDAY + 5 * 60_000)).toMatchObject({ workspaces: 1, emails: 2 });
    expect(smtp.messages.map((m) => m.to[0]).sort()).toEqual(['erin@example.com', 'owner@example.com']);

    const raw = smtp.messages.find((m) => m.to[0] === 'erin@example.com')!.raw;
    expect(mailHeader(raw, 'Subject')).toBe('Ivy weekly digest for Acme: 412 errors, 1 new group');
    expect(mailHeader(raw, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
    const unsubscribe = /<(https:\/\/ivy\.example\.test\/api\/digest\/unsubscribe\?token=[^>]+)>/.exec(mailHeader(raw, 'List-Unsubscribe')!)![1];
    expect(readUnsubscribeToken(new URL(unsubscribe).searchParams.get('token')!)).toEqual({ tenant: acme.id, sub: erin.sub });

    const body = decodedMail(raw);
    expect(raw).toMatch(/Content-Type: text\/plain/i);
    expect(raw).toMatch(/Content-Type: text\/html/i);
    expect(body).toContain('Errors: 412 (+100% vs last week)');
    expect(body).toContain('Failures outside the handler: 3 (new vs last week)');
    expect(body).toContain('Throttles: 17 (same vs last week)');
    expect(body).toContain('Out of memory: Runtime.OutOfMemory');
    expect(body).toContain('400× (+100%) TypeError');
    expect(body).toContain('https://ivy.example.test/w/acme/default/traces/673f1a2b0000000000000000000000aa');
    expect(body).toContain('signal: killed &lt;b&gt;');
    expect(body).toContain('9 Nov – 15 Nov');
  });

  it('is sent once per workspace and week, also with several processes or restarts', async () => {
    await sendDueDigests(MONDAY);
    resetDigestRunsForTests(); // as if another process (or a restart) looked again
    expect(await sendDueDigests(MONDAY + 30 * 60_000)).toMatchObject({ emails: 0 });
    expect(smtp.messages).toHaveLength(2);
    expect(await alertStore().digestSent(acme.id, '2026-11-16')).toBe(true);
    // A day late is still sent (e.g. after downtime); next week is a new digest.
    resetDigestRunsForTests();
    expect(await sendDueDigests(MONDAY + 7 * DAY + 23 * 3600_000)).toMatchObject({ emails: 2 });
  });

  it('skips workspaces with no data, switched off, or without SMTP', async () => {
    weeks.delete(acme.id);
    expect(await sendDueDigests(MONDAY)).toMatchObject({ emails: 0, skipped: 2 });
    resetDigestRunsForTests();
    weeks.set(acme.id, acmeWeek());
    await alertStore().setDigestEnabled(acme.id, false);
    expect(await sendDueDigests(MONDAY)).toMatchObject({ emails: 0 });
    await alertStore().setDigestEnabled(acme.id, true);
    vi.stubEnv('IVY_SMTP_URL', '');
    expect(await sendDueDigests(MONDAY)).toMatchObject({ emails: 0 });
    expect(smtp.messages).toHaveLength(0);
  });

  it('follows IVY_DIGEST_CRON', async () => {
    vi.stubEnv('IVY_DIGEST_CRON', '30 16 * * 5');
    expect(await sendDueDigests(MONDAY)).toMatchObject({ emails: 0 });
    expect(await sendDueDigests(Date.UTC(2026, 10, 20, 16, 31))).toMatchObject({ emails: 2 });
  });

  it('honours opt-outs: the unsubscribe link (no sign-in) and the notification settings', async () => {
    const token = unsubscribeToken(acme.id, erin.sub)!;
    const page = await app.request(`/api/digest/unsubscribe?token=${encodeURIComponent(token)}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Unsubscribe from Acme’s weekly digest?');
    // GET alone changes nothing (link scanners); POST (also RFC 8058 one-click) does.
    expect((await digestRecipients(acme.id)).map((r) => r.email).sort()).toEqual(['erin@example.com', 'owner@example.com']);
    const post = await app.request(`/api/digest/unsubscribe?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(post.status).toBe(200);
    expect(await post.text()).toContain('You are unsubscribed');
    expect((await digestRecipients(acme.id)).map((r) => r.email)).toEqual(['owner@example.com']);

    expect((await app.request(`/api/digest/unsubscribe?token=${encodeURIComponent(token)}x`, { method: 'POST' })).status).toBe(400);
    expect((await app.request('/api/digest/unsubscribe', { method: 'POST' })).status).toBe(400);

    // Erin sees it in her settings and subscribes again.
    const mine = await call(erin, 'GET', '/api/me/notifications');
    expect(mine.body).toMatchObject({ email: 'erin@example.com', digest_available: true });
    expect(mine.body.items).toEqual(
      expect.arrayContaining([{ workspace: expect.objectContaining({ slug: 'acme' }), digest: false }]),
    );
    expect((await call(erin, 'PUT', '/api/me/notifications', { workspace: 'acme', digest: true })).body).toMatchObject({ digest: true });
    expect((await digestRecipients(acme.id)).map((r) => r.email).sort()).toEqual(['erin@example.com', 'owner@example.com']);
    expect((await call(erin, 'PUT', '/api/me/notifications', { workspace: 'not-mine', digest: false })).status).toBe(404);
    expect((await call(erin, 'PUT', '/api/me/notifications', { workspace: 'acme', digest: 'no' })).status).toBe(400);
  });

  it('has workspace settings: owners switch it off, everyone previews', async () => {
    expect((await call(erin, 'GET', '/api/w/acme/digest')).body).toEqual({
      available: true,
      missing: [],
      schedule: '0 8 * * 1',
      enabled: true,
      can_edit: false,
      subscribed: true,
      recipients: 2,
    });
    expect((await call(erin, 'PUT', '/api/w/acme/digest', { enabled: false })).status).toBe(403);
    expect((await call(owner, 'PUT', '/api/w/acme/digest', { enabled: false })).body).toEqual({ enabled: false });
    expect((await call(owner, 'GET', '/api/w/acme/digest')).body.enabled).toBe(false);
    const preview = await call(erin, 'GET', '/api/w/acme/digest/preview');
    expect(preview.body).toMatchObject({ subject: expect.stringContaining('Ivy weekly digest for Acme'), empty: false });
    expect(preview.body.html).toContain('<!doctype html>');
    expect(preview.body.text).toContain('Top error groups');
  });
});

describe('new functions not traced yet', () => {
  const period = digestPeriod(MONDAY);

  async function seed() {
    await aws.store.saveAccount(awsAccount(acme.id));
    const at = (days: number) => period.from + days * DAY;
    await aws.store.replaceRegionFunctions(acme.id, 'conn-1', 'eu-west-1', [
      lambdaFn(acme.id, 'orders-a', at(1)),
      lambdaFn(acme.id, 'orders-b', at(2)),
      lambdaFn(acme.id, 'orders-c', at(3)),
      lambdaFn(acme.id, 'orders-d', at(4)),
      lambdaFn(acme.id, 'orders-e', at(5)),
      lambdaFn(acme.id, 'before-week', period.from - 1),
      lambdaFn(acme.id, 'after-week', period.to),
      lambdaFn(acme.id, 'tagged-off', at(1), 'opted_out', { 'ivy:trace': 'false' }),
      lambdaFn(acme.id, 'excluded', at(1), 'opted_out'),
      lambdaFn(acme.id, 'excluded-stale', at(1)),
      lambdaFn(acme.id, 'python-fn', at(1), 'unsupported'),
      lambdaFn(acme.id, 'traced-fn', at(1), 'traced'),
    ]);
    await aws.store.saveSetting(acme.id, { account_id: 'conn-1', region: 'eu-west-1', function_name: 'excluded-stale', mode: 'exclude', project_id: '' });
  }

  it('lists the first three of the week, then "and N more", skipping excluded, unsupported and traced ones', async () => {
    await seed();
    expect(await newUntracedFunctions(acme.id, period)).toEqual({ names: ['orders-a', 'orders-b', 'orders-c'], more: 2 });

    await sendDueDigests(MONDAY + 5 * 60_000);
    const body = decodedMail(smtp.messages[0].raw);
    expect(body).toContain('New functions not traced yet');
    expect(body).toContain('orders-a, orders-b, orders-c and 2 more.');
    expect(body).toContain('Choose what to trace: https://ivy.example.test/w/acme/settings/aws');
    expect(body).not.toContain('before-week');
    expect(body).not.toContain('excluded-stale');
  });

  it('is in the settings preview too', async () => {
    await aws.store.saveAccount(awsAccount(acme.id));
    await aws.store.saveFunction(lambdaFn(acme.id, 'fresh-fn', Date.now() - 60_000));
    const preview = (await call(erin, 'GET', '/api/w/acme/digest/preview')).body;
    expect(preview.text).toContain('New functions not traced yet\nfresh-fn.');
    expect(preview.html).toContain('Choose what to trace');
  });

  it('is left out without new untraced functions or without connected accounts', async () => {
    expect(await newUntracedFunctions(acme.id, period)).toBeNull();
    await aws.store.saveAccount(awsAccount(acme.id, 'pending'));
    await aws.store.saveFunction(lambdaFn(acme.id, 'orders-a', period.from + DAY));
    expect(await newUntracedFunctions(acme.id, period)).toBeNull();
    await aws.store.saveAccount(awsAccount(acme.id));
    await aws.store.saveFunction(lambdaFn(acme.id, 'orders-a', period.from + DAY, 'traced'));
    expect(await newUntracedFunctions(acme.id, period)).toBeNull();

    await sendDueDigests(MONDAY + 5 * 60_000);
    expect(decodedMail(smtp.messages[0].raw)).not.toContain('not traced yet');
  });
});
