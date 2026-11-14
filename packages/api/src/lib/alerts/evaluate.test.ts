import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../tenancy/secret-box.js';
import { createProject } from '../tenancy/projects.js';
import type { ProjectRecord, TenantRecord } from '../tenancy/store.js';
import { resetTenancyForTests, testWorkspace } from '../tenancy/testing.js';
import { setAlertDataForTests, type AlertDataSource, type AlertGroup } from './data.js';
import { decide, evaluateAlerts, MAX_MESSAGES_PER_RUN } from './evaluate.js';
import { alertRunner } from './loop.js';
import { alertStore, DEFAULT_ALERT_SETTINGS, memoryAlertStore, setAlertStore, type SlackIntegration } from './store.js';
import { startFakeSlack } from './testing.js';

const SECRET = 'test-secret-key';
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);

let slack: Awaited<ReturnType<typeof startFakeSlack>>;
let workspace: TenantRecord;
let project: ProjectRecord;

/** Occurrences per fingerprint, as the fake data source's "invocations table". */
let occurrences: Map<string, { group: Omit<AlertGroup, 'total' | 'first_seen' | 'last_seen' | 'since_notify'>; times: number[] }>;
let stackCalls = 0;

const fakeData: AlertDataSource = {
  async activeGroups(scope, { since, notified, throttles }) {
    if (scope.projectId !== project.id) return [];
    return [...occurrences.values()]
      .filter(({ group, times }) => times.some((t) => t >= since) && (throttles || group.kind === 'error'))
      .map(({ group, times }) => ({
        ...group,
        total: times.length,
        first_seen: Math.min(...times),
        last_seen: Math.max(...times),
        since_notify: times.filter((t) => t > (notified.get(group.fingerprint) ?? 0)).length,
      }));
  },
  async stackLine() {
    stackCalls++;
    return 'at handler (/var/task/index.mjs:12:5)';
  },
  async digest() {
    throw new Error('not used');
  },
};

function occur(fingerprint: string, at: number, count = 1, extra: Partial<AlertGroup> = {}) {
  const entry = occurrences.get(fingerprint) ?? {
    group: {
      fingerprint,
      function: 'checkout-createOrder',
      kind: 'error' as const,
      error_type: 'TypeError',
      error_message: `Cannot read properties of undefined (reading 'id') [${fingerprint}]`,
      failure_kind: null,
      sample_trace_id: '673f1a2b0000000000000000000000aa',
      ...extra,
    },
    times: [],
  };
  for (let i = 0; i < count; i++) entry.times.push(at);
  occurrences.set(fingerprint, entry);
}

async function connect(hook = 'main', created_at = T0 - 60 * MIN): Promise<SlackIntegration> {
  const integration: SlackIntegration = {
    tenant_id: workspace.id,
    project_id: project.id,
    id: `slk_${hook}`,
    team_id: 'T0123',
    team_name: 'Acme',
    channel: '#alerts',
    channel_id: `C_${hook}`,
    encrypted_webhook_url: encrypt(slack.hookUrl(hook), SECRET),
    configuration_url: '',
    status: 'ok',
    error: '',
    created_by: 'idn_owner',
    created_at,
  };
  await alertStore().saveIntegration(integration);
  return integration;
}

const texts = () => slack.posts.map((p) => p.body.text as string);

beforeAll(async () => {
  slack = await startFakeSlack();
});

afterAll(async () => {
  await slack.close();
  vi.unstubAllEnvs();
  setAlertDataForTests(undefined);
});

beforeEach(async () => {
  await resetTenancyForTests();
  workspace = await testWorkspace('Acme', 'acme');
  project = await createProject(workspace.id, { name: 'Checkout (prod)', slug: 'checkout-prod' });
  setAlertStore(memoryAlertStore());
  setAlertDataForTests(fakeData);
  occurrences = new Map();
  stackCalls = 0;
  slack.reset();
  vi.stubEnv('IVY_SLACK_CLIENT_ID', 'cid');
  vi.stubEnv('IVY_SLACK_CLIENT_SECRET', 'csecret');
  vi.stubEnv('IVY_PUBLIC_URL', 'https://ivy.example.test');
  vi.stubEnv('IVY_SECRET_KEY', SECRET);
  vi.stubEnv('IVY_HOOKS_DIR', '/nonexistent-ivy-hooks');
});

describe('decide', () => {
  const group = (over: Partial<AlertGroup>): AlertGroup => ({
    fingerprint: 'fp',
    function: 'f',
    kind: 'error',
    error_type: 'E',
    error_message: '',
    failure_kind: null,
    sample_trace_id: null,
    total: 1,
    first_seen: T0,
    last_seen: T0,
    since_notify: 1,
    ...over,
  });
  const state = (last: number) => ({ tenant_id: 't', project_id: 'p', fingerprint: 'fp', first_notified_at: last, last_notified_at: last, occurrences_at_last_notify: 1 });

  it('sends on first seen, and only baselines groups from before alerts were set up', () => {
    expect(decide(group({}), undefined, DEFAULT_ALERT_SETTINGS, T0, T0 - MIN)).toEqual({ send: true, first: true });
    expect(decide(group({ first_seen: T0 - 2 * MIN }), undefined, DEFAULT_ALERT_SETTINGS, T0, T0 - MIN)).toEqual({ send: false, baseline: true });
  });

  it('then at most every 60 minutes or every 100 occurrences', () => {
    const s = state(T0);
    expect(decide(group({ since_notify: 99 }), s, DEFAULT_ALERT_SETTINGS, T0 + 59 * MIN, 0).send).toBe(false);
    expect(decide(group({ since_notify: 100 }), s, DEFAULT_ALERT_SETTINGS, T0 + MIN, 0)).toEqual({ send: true, first: false });
    expect(decide(group({ since_notify: 1 }), s, DEFAULT_ALERT_SETTINGS, T0 + 60 * MIN, 0)).toEqual({ send: true, first: false });
    expect(decide(group({ since_notify: 0 }), s, DEFAULT_ALERT_SETTINGS, T0 + 600 * MIN, 0).send).toBe(false);
  });

  it('uses custom thresholds', () => {
    const custom = { ...DEFAULT_ALERT_SETTINGS, interval_minutes: 5, every_occurrences: 3 };
    expect(decide(group({ since_notify: 3 }), state(T0), custom, T0 + MIN, 0).send).toBe(true);
    expect(decide(group({ since_notify: 1 }), state(T0), custom, T0 + 4 * MIN, 0).send).toBe(false);
    expect(decide(group({ since_notify: 1 }), state(T0), custom, T0 + 5 * MIN, 0).send).toBe(true);
  });
});

describe('evaluateAlerts', () => {
  it('posts when a group is first seen, then not again until a threshold is reached', async () => {
    await connect();
    occur('fp1', T0 - MIN);
    expect(await evaluateAlerts({ now: T0 })).toMatchObject({ messages: 1 });
    expect(texts()[0]).toMatch(/^New error in Checkout \(prod\): TypeError/);
    expect(texts()[0]).toContain('First seen');
    expect(stackCalls).toBe(1);

    // Same minute again, and 30 minutes later with a few more: nothing.
    expect(await evaluateAlerts({ now: T0 })).toMatchObject({ messages: 0 });
    occur('fp1', T0 + 10 * MIN, 5);
    expect(await evaluateAlerts({ now: T0 + 30 * MIN })).toMatchObject({ messages: 0 });

    // After 60 minutes: one message with the count since the last one.
    occur('fp1', T0 + 59 * MIN);
    expect(await evaluateAlerts({ now: T0 + 60 * MIN })).toMatchObject({ messages: 1 });
    expect(texts()[1]).toContain('6 more in the last 60 min · 7 total');

    // No new occurrences: silence however long it takes.
    expect(await evaluateAlerts({ now: T0 + 70 * MIN })).toMatchObject({ messages: 0 });
  });

  it('posts after 100 occurrences without waiting for the hour', async () => {
    await connect();
    occur('fp1', T0 - MIN);
    await evaluateAlerts({ now: T0 });
    occur('fp1', T0 + MIN, 99);
    expect(await evaluateAlerts({ now: T0 + 2 * MIN })).toMatchObject({ messages: 0 });
    occur('fp1', T0 + 2 * MIN);
    expect(await evaluateAlerts({ now: T0 + 3 * MIN })).toMatchObject({ messages: 1 });
    expect(texts()[1]).toContain('100 more in the last 3 min · 101 total');
    const [state] = await alertStore().listStates(workspace.id, project.id);
    expect(state).toMatchObject({ first_notified_at: T0, last_notified_at: T0 + 3 * MIN, occurrences_at_last_notify: 101 });
  });

  it('follows the project’s custom thresholds and the on/off switch', async () => {
    await connect();
    await alertStore().saveSettings(workspace.id, project.id, { ...DEFAULT_ALERT_SETTINGS, interval_minutes: 10, every_occurrences: 5 });
    occur('fp1', T0 - MIN);
    await evaluateAlerts({ now: T0 });
    occur('fp1', T0 + MIN, 5);
    expect(await evaluateAlerts({ now: T0 + 2 * MIN })).toMatchObject({ messages: 1 });
    occur('fp1', T0 + 3 * MIN);
    expect(await evaluateAlerts({ now: T0 + 12 * MIN })).toMatchObject({ messages: 1 });

    await alertStore().saveSettings(workspace.id, project.id, { ...DEFAULT_ALERT_SETTINGS, slack_enabled: false });
    occur('fp2', T0 + 13 * MIN);
    expect(await evaluateAlerts({ now: T0 + 14 * MIN })).toMatchObject({ messages: 0, projects: 0 });
  });

  it('does not post every existing error when Slack is connected', async () => {
    occur('old', T0 - 3 * 3600_000);
    occur('old', T0 - MIN);
    await connect('main', T0 - 5 * MIN);
    expect(await evaluateAlerts({ now: T0 })).toMatchObject({ messages: 0 });
    expect((await alertStore().listStates(workspace.id, project.id))[0]).toMatchObject({ fingerprint: 'old', last_notified_at: T0 });
    occur('old', T0 + 30 * MIN);
    expect(await evaluateAlerts({ now: T0 + 61 * MIN })).toMatchObject({ messages: 1 });
  });

  it('includes the synthetic Throttled groups only when the project asks for them', async () => {
    await connect();
    occur('throttled:eu-west-1:checkout-createOrder', T0 - MIN, 12, { kind: 'throttle', error_type: 'Throttled', sample_trace_id: null });
    expect(await evaluateAlerts({ now: T0 })).toMatchObject({ messages: 0 });
    await alertStore().saveSettings(workspace.id, project.id, { ...DEFAULT_ALERT_SETTINGS, include_throttles: true });
    expect(await evaluateAlerts({ now: T0 + MIN })).toMatchObject({ messages: 1 });
    expect(texts()[0]).toContain('Throttled');
    // No trace for throttles: the button goes to the errors page, and there is no stack lookup.
    expect(JSON.stringify(slack.posts[0].body)).toContain('/w/acme/checkout-prod/errors?function=checkout-createOrder');
    expect(stackCalls).toBe(0);
  });

  it('includes failures outside the handler', async () => {
    await connect();
    occur('oom', T0 - MIN, 1, { error_type: 'Runtime.OutOfMemory', failure_kind: 'out_of_memory' });
    await evaluateAlerts({ now: T0 });
    expect(texts()[0]).toContain('Out of memory: Runtime.OutOfMemory');
  });

  it('posts to every channel of the project and caps messages per run', async () => {
    await connect('one');
    await connect('two');
    for (let i = 0; i < MAX_MESSAGES_PER_RUN + 2; i++) occur(`fp${i}`, T0 - MIN);
    expect(await evaluateAlerts({ now: T0 })).toMatchObject({ messages: 2 * MAX_MESSAGES_PER_RUN });
    expect(new Set(slack.posts.map((p) => p.hook))).toEqual(new Set(['one', 'two']));
    // The rest follow on the next run.
    expect(await evaluateAlerts({ now: T0 + MIN })).toMatchObject({ messages: 4 });
  });

  it('marks a channel Slack rejects as gone broken, and stops posting to it', async () => {
    await connect('gone');
    slack.queue('gone', { status: 404, body: 'channel_not_found' });
    occur('fp1', T0 - MIN);
    expect(await evaluateAlerts({ now: T0 })).toMatchObject({ messages: 0 });
    const [integration] = await alertStore().listIntegrations(workspace.id, project.id);
    expect(integration).toMatchObject({ status: 'broken', error: 'HTTP 404 channel_not_found' });
    occur('fp2', T0 + MIN);
    await evaluateAlerts({ now: T0 + 2 * MIN });
    expect(slack.posts).toHaveLength(1);
  });

  it('retries a 429 with Retry-After and a 5xx, then delivers', async () => {
    await connect();
    slack.queue('main', { status: 429, body: 'rate_limited', headers: { 'retry-after': '1' } }, { status: 503, body: 'unavailable' });
    occur('fp1', T0 - MIN);
    const started = Date.now();
    expect(await evaluateAlerts({ now: T0 })).toMatchObject({ messages: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(slack.posts).toHaveLength(3);
  });

  it('sends nothing without the Slack configuration', async () => {
    await connect();
    vi.stubEnv('IVY_SLACK_CLIENT_SECRET', '');
    occur('fp1', T0 - MIN);
    expect(await evaluateAlerts({ now: T0 })).toMatchObject({ messages: 0 });
    expect(slack.posts).toHaveLength(0);
  });
});

describe('one evaluation at a time', () => {
  it('never sends twice when runs overlap, in one process or across processes', async () => {
    await connect();
    occur('fp1', T0 - MIN);
    const a = alertRunner('host-a:1');
    const b = alertRunner('host-b:2');
    const results = await Promise.all([a.tick(T0, MIN), a.tick(T0, MIN), b.tick(T0, MIN)]);
    expect(slack.posts).toHaveLength(1);
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    // The leader keeps the lease; the other process only takes over once it expires.
    expect(await b.tick(T0 + MIN, MIN)).toBe(false);
    expect(await a.tick(T0 + MIN, MIN)).toBe(true);
    expect(await b.tick(T0 + 10 * MIN, MIN)).toBe(true);
    expect(slack.posts).toHaveLength(1);
  });
});

describe('on-error-group-created', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ivy-alert-hooks-')));
  const out = path.join(dir, 'out.json');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('fires once for a new group, also in projects without Slack', async () => {
    writeFileSync(path.join(dir, 'on-error-group-created'), '#!/bin/sh\ncat >> "$HOOK_OUT"\necho >> "$HOOK_OUT"\n');
    chmodSync(path.join(dir, 'on-error-group-created'), 0o755);
    vi.stubEnv('IVY_HOOKS_DIR', dir);
    vi.stubEnv('HOOK_OUT', out);
    occur('fp1', T0 - MIN);
    expect(await evaluateAlerts({ now: T0, hookSince: T0 - 5 * MIN })).toMatchObject({ hooks: 1, messages: 0 });
    expect(await evaluateAlerts({ now: T0 + MIN, hookSince: T0 - 5 * MIN })).toMatchObject({ hooks: 0 });
    await vi.waitFor(() => expect(existsSync(out) && readFileSync(out, 'utf8').trim()).toBeTruthy(), { timeout: 5000 });
    const events = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      version: 1,
      hook: 'on-error-group-created',
      data: {
        workspace: { slug: 'acme' },
        project: { slug: 'checkout-prod' },
        group: { fingerprint: 'fp1', kind: 'error', error_type: 'TypeError', occurrences: 1, url: expect.stringContaining('/w/acme/checkout-prod/traces/') },
      },
    });
  });
});
