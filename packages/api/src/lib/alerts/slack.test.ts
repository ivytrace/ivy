import { describe, expect, it } from 'vitest';
import { cronMatches, lastRun, parseCron } from './cron.js';
import type { AlertGroup } from './data.js';
import { firstFrame } from './data.js';
import { sign, verify } from './signing.js';
import { countLine, formatGroupMessage, formatTestMessage } from './slack.js';

const group: AlertGroup = {
  fingerprint: 'a1b2c3',
  function: 'checkout-createOrder',
  kind: 'error',
  error_type: 'TypeError',
  error_message: `Cannot read properties of undefined (reading 'id') <script> & ${'x'.repeat(400)}`,
  failure_kind: null,
  sample_trace_id: '673f1a2b0000000000000000000000aa',
  total: 412,
  first_seen: 0,
  last_seen: 0,
  since_notify: 37,
};

const ctx = {
  workspace: { slug: 'acme', name: 'Acme' },
  project: { slug: 'checkout-prod', name: 'Checkout (prod)' },
  baseUrl: 'https://ivy.example.test',
  sinceMinutes: 60,
  stack: 'at handler (/var/task/index.mjs:12:5)',
};

describe('Slack messages', () => {
  it('carry type, trimmed message, function, project, workspace, counts, a stack line and a link', () => {
    const msg = formatGroupMessage(group, ctx, false);
    const json = JSON.stringify(msg);
    expect(msg.text).toMatch(/^Error in Checkout \(prod\): TypeError · Cannot read properties/);
    expect(json).toContain('37 more in the last 60 min · 412 total');
    expect(json).toContain('`checkout-createOrder`');
    expect(json).toContain('Checkout (prod) · Acme');
    expect(json).toContain('at handler (/var/task/index.mjs:12:5)');
    expect(json).toContain('https://ivy.example.test/w/acme/checkout-prod/traces/673f1a2b0000000000000000000000aa');
    expect(json).toContain('View in Ivy');
    // Escaped for mrkdwn, and trimmed.
    expect(json).toContain('&lt;script&gt; &amp;');
    expect(json).not.toContain('x'.repeat(300));
    const section = msg.blocks[0] as { text: { text: string } };
    expect(section.text.text.length).toBeLessThan(500);
  });

  it('never include payloads or log lines, whatever the group carries', () => {
    const withExtras = { ...group, payload: { email: 'jane@example.com' }, logs: ['card 4242 4242 4242 4242'] } as unknown as AlertGroup;
    const json = JSON.stringify(formatGroupMessage(withExtras, ctx, true));
    expect(json).not.toContain('jane@example.com');
    expect(json).not.toContain('4242');
    expect(Object.keys(formatGroupMessage(group, ctx, true))).toEqual(['text', 'blocks']);
  });

  it('say "first seen" for new groups', () => {
    expect(countLine({ ...group, total: 1, since_notify: 1 }, true, null)).toBe('First seen');
    expect(countLine({ ...group, total: 3, since_notify: 3 }, true, null)).toBe('First seen · 3 occurrences so far');
    expect(formatGroupMessage({ ...group, total: 1, since_notify: 1 }, { ...ctx, sinceMinutes: null }, true).text).toMatch(/^New error in/);
    expect(countLine(group, false, 180)).toBe('37 more in the last 3 h · 412 total');
  });

  it('link throttles (no trace) to the errors page of the function', () => {
    const json = JSON.stringify(formatGroupMessage({ ...group, kind: 'throttle', error_type: 'Throttled', sample_trace_id: null }, ctx, true));
    expect(json).toContain('https://ivy.example.test/w/acme/checkout-prod/errors?function=checkout-createOrder');
  });

  it('have a test message pointing at the alert settings', () => {
    expect(JSON.stringify(formatTestMessage(ctx))).toContain('https://ivy.example.test/w/acme/settings/alerts/checkout-prod');
  });

  it('take only the first frame of a stack, never the message line', () => {
    expect(firstFrame("TypeError: secret jane@example.com\n    at handler (/var/task/index.mjs:12:5)\n    at x")).toBe('at handler (/var/task/index.mjs:12:5)');
    expect(firstFrame('no frames here')).toBeNull();
  });
});

describe('signed tokens', () => {
  it('round-trip, and reject tampering, other purposes, other secrets and expiry', () => {
    const token = sign({ w: 'ten_1', exp: 2000 }, 's1', 'a');
    expect(verify(token, 's1', 'a', 1000)).toEqual({ w: 'ten_1', exp: 2000 });
    expect(verify(token, 's1', 'a', 3000)).toBeNull();
    expect(verify(token, 's1', 'b', 1000)).toBeNull();
    expect(verify(token, 's2', 'a', 1000)).toBeNull();
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ w: 'ten_2', exp: 2000 })).toString('base64url');
    expect(verify(`${forged}.${mac}`, 's1', 'a', 1000)).toBeNull();
    expect(verify(`${body}.${mac}x`, 's1', 'a', 1000)).toBeNull();
    expect(verify('garbage', 's1', 'a')).toBeNull();
  });
});

describe('cron', () => {
  it('matches the default Monday 08:00 UTC and finds the latest run', () => {
    const cron = parseCron('0 8 * * 1');
    expect(cronMatches(cron, new Date(Date.UTC(2026, 10, 16, 8, 0)))).toBe(true); // a Monday
    expect(cronMatches(cron, new Date(Date.UTC(2026, 10, 17, 8, 0)))).toBe(false);
    expect(lastRun(cron, Date.UTC(2026, 10, 16, 9, 30), 86_400_000)).toBe(Date.UTC(2026, 10, 16, 8, 0));
    expect(lastRun(cron, Date.UTC(2026, 10, 18, 9, 30), 86_400_000)).toBeNull();
  });

  it('supports lists, ranges, steps and Sunday as 7', () => {
    const cron = parseCron('*/15 9-17 * * 1-5,7');
    expect(cronMatches(cron, new Date(Date.UTC(2026, 10, 15, 9, 45)))).toBe(true); // Sunday
    expect(cronMatches(cron, new Date(Date.UTC(2026, 10, 14, 9, 45)))).toBe(false); // Saturday
    expect(() => parseCron('0 8 * *')).toThrow();
    expect(() => parseCron('61 8 * * 1')).toThrow();
  });
});
