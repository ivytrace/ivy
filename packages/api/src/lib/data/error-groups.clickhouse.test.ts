import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { errorTemplateSql } from '@ivy/spans';
import { TEMPLATE_VECTORS } from '@ivy/spans/error-template-vectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clickhouseAlertData } from '../alerts/data.js';
import { setClientsForTests } from '../clickhouse/client.js';
import { schemaStatements } from '../clickhouse/test-schema.js';
import { errorGroups } from './errors.js';
import { listInvocations } from './invocations.js';

/**
 * Error grouping against a real ClickHouse: the template rules in SQL (the same vectors as the unit test), the code
 * location the materialized view extracts, and the groups, invocation filter and alert reads built on them.
 *   IVY_TEST_CLICKHOUSE_URL=http://localhost:8123 pnpm --filter @ivy/api test error-groups
 * (credentials from IVY_CLICKHOUSE_USER / IVY_CLICKHOUSE_PASSWORD, default ivy/ivy). Skipped without it.
 */
const url = process.env.IVY_TEST_CLICKHOUSE_URL;
const db = `ivy_test_errors_${process.pid}_${Date.now()}`;
const tenant = { id: 'ten_test', shardId: 'shard-1' };
const scope = { tenant, projectId: 'prj_test' };
const T0 = Date.UTC(2026, 11, 14, 10, 0, 0);
const MIN = 60_000;
const DAY = 24 * 3600_000;
let admin: ClickHouseClient;

const jsStack = (message: string, line: number, location = '/var/task/uploads.mjs', fn = 'getUpload') =>
  [
    `Error: ${message}`,
    '    at Object.send (/var/task/node_modules/@aws-sdk/client-s3/dist-cjs/index.js:120:20)',
    `    at async ${fn} (file://${location}:${line}:11)`,
    '    at async Runtime.handler (file:///var/task/index.mjs:9:5)',
    '    at async Runtime.handleOnceNonStreaming (file:///var/runtime/index.mjs:1173:26)',
  ].join('\n');

interface ErrorSpan {
  fn?: string;
  type?: string;
  message: string;
  stack?: string;
  at: number;
}

let seq = 0;
function row(e: ErrorSpan) {
  const n = ++seq;
  const hex = n.toString(16).padStart(8, '0');
  const fn = e.fn ?? 'uploads-get';
  return {
    TenantId: tenant.id,
    ProjectId: scope.projectId,
    Timestamp: new Date(e.at).toISOString().replace('T', ' ').replace('Z', ''),
    TraceId: `6aa1c6a0${hex}${'0'.repeat(16)}`,
    SpanId: `${hex}${'0'.repeat(8)}`,
    ParentSpanId: '',
    SpanName: fn,
    SpanKind: 'Server',
    ServiceName: fn,
    ResourceAttributes: { 'faas.name': fn, 'cloud.region': 'eu-west-1' },
    SpanAttributes: { 'ivy.invocation': 'true', 'faas.invocation_id': `req-${n}`, 'error.type': e.type ?? 'Error' },
    Duration: 50e6,
    StatusCode: 'Error',
    StatusMessage: e.message,
    'Events.Timestamp': e.stack ? [new Date(e.at).toISOString().replace('T', ' ').replace('Z', '')] : [],
    'Events.Name': e.stack ? ['exception'] : [],
    'Events.Attributes': e.stack ? [{ 'exception.type': e.type ?? 'Error', 'exception.message': e.message, 'exception.stacktrace': e.stack }] : [],
  };
}

const PRODUCTION = ['fonts/mono-regular.woff', 'favicon.ico', '_code-highlighting.js', 'fonts/semibold.woff2'];

describe.skipIf(!url)('error grouping in ClickHouse', () => {
  beforeAll(async () => {
    admin = createClient({ url, username: process.env.IVY_CLICKHOUSE_USER ?? 'ivy', password: process.env.IVY_CLICKHOUSE_PASSWORD ?? 'ivy' });
    await admin.command({ query: `CREATE DATABASE ${db}` });
    for (const query of schemaStatements(db)) await admin.command({ query });
    const shard = createClient({
      url,
      username: process.env.IVY_CLICKHOUSE_USER ?? 'ivy',
      password: process.env.IVY_CLICKHOUSE_PASSWORD ?? 'ivy',
      database: db,
      clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
    });
    setClientsForTests({ shard, control: shard });

    const spans: ErrorSpan[] = [
      // The production case: one bug, four paths, three deploys (line numbers differ).
      ...PRODUCTION.flatMap((path, i) =>
        [0, 1, 2].map((k) => ({ message: `Upload not found for ID: ${path}`, stack: jsStack(`Upload not found for ID: ${path}`, 40 + k), at: T0 + (i * 3 + k) * MIN })),
      ),
      // Same message pattern, different code location: another bug.
      { message: 'Upload not found for ID: logo.png', stack: jsStack('Upload not found for ID: logo.png', 12, '/var/task/thumbnails.mjs', 'resize'), at: T0 + 20 * MIN },
      // Same message, different error type.
      { type: 'NoSuchKey', message: 'Upload not found for ID: favicon.ico', stack: jsStack('Upload not found for ID: favicon.ico', 40), at: T0 + 21 * MIN },
      // No stack at all: grouped by function, type and template.
      { fn: 'billing-sync', type: 'StripeInvalidRequestError', message: "No such customer: 'cus_NffrFeUfNV2Hib'", at: T0 + 22 * MIN },
      { fn: 'billing-sync', type: 'StripeInvalidRequestError', message: "No such customer: 'cus_Q2w8ErTy5Ui9Op'", at: T0 + 23 * MIN },
      // Init failures by missing module stay apart.
      { fn: 'reports-export', type: 'Runtime.ImportModuleError', message: "Error: Cannot find module 'left-pad'", at: T0 + 24 * MIN },
      { fn: 'reports-export', type: 'Runtime.ImportModuleError', message: "Error: Cannot find module 'mjml'", at: T0 + 25 * MIN },
      // Python: the innermost in-app frame (the last one), packages skipped.
      {
        fn: 'py-worker',
        type: 'KeyError',
        message: "'order_id'",
        stack: [
          'Traceback (most recent call last):',
          '  File "/var/task/app.py", line 12, in handler',
          '    return process(event)',
          '  File "/var/task/orders.py", line 33, in process',
          '    return event["order_id"]',
          '  File "/var/task/vendor/site-packages/boto3/x.py", line 5, in call',
          "KeyError: 'order_id'",
        ].join('\n'),
        at: T0 + 26 * MIN,
      },
      // Alerts: a template seen two days before (stored before code locations existed: no stack), then again now.
      { fn: 'mail-send', message: 'Mailbox full for bob@example.com', at: T0 - 2 * DAY },
      { fn: 'mail-send', message: 'Mailbox full for carol@example.com', stack: jsStack('Mailbox full', 7, '/var/task/mail.mjs', 'send'), at: T0 + 27 * MIN },
      // …and a template nobody has seen before.
      { fn: 'mail-send', message: 'Quota exceeded for 3 recipients', stack: jsStack('Quota exceeded', 9, '/var/task/mail.mjs', 'send'), at: T0 + 28 * MIN },
    ];
    await admin.insert({ table: `${db}.otel_traces`, values: spans.map(row), format: 'JSONEachRow' });
  }, 60_000);

  afterAll(async () => {
    setClientsForTests(undefined);
    await admin?.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin?.close();
  });

  const range = { from: T0 - MIN, to: T0 + 3600_000 };

  it('applies the template rules exactly like errorTemplate', async () => {
    const result = await admin.query({
      query: `SELECT ${errorTemplateSql('m', 't')} AS template
              FROM (
                SELECT i, {types:Array(String)}[i] AS t, {messages:Array(String)}[i] AS m
                FROM (SELECT arrayJoin(range(1, length({types:Array(String)}) + 1)) AS i)
              )
              ORDER BY i`,
      query_params: { types: TEMPLATE_VECTORS.map((v) => v[0]), messages: TEMPLATE_VECTORS.map((v) => v[1]) },
      format: 'JSONEachRow',
    });
    const templates = (await result.json<{ template: string }>()).map((r) => r.template);
    expect(templates).toEqual(TEMPLATE_VECTORS.map((v) => v[2]));
  });

  it('stores the top in-app frame without line numbers', async () => {
    const result = await admin.query({
      query: `SELECT DISTINCT function, error_frame FROM ${db}.invocations ORDER BY function, error_frame`,
      format: 'JSONEachRow',
    });
    expect(await result.json()).toEqual([
      { function: 'billing-sync', error_frame: '' },
      { function: 'mail-send', error_frame: '' },
      { function: 'mail-send', error_frame: '/var/task/mail.mjs:send' },
      { function: 'py-worker', error_frame: '/var/task/orders.py:process' },
      { function: 'reports-export', error_frame: '' },
      { function: 'uploads-get', error_frame: '/var/task/thumbnails.mjs:resize' },
      { function: 'uploads-get', error_frame: '/var/task/uploads.mjs:getUpload' },
    ]);
  });

  it('groups the production messages into one group with its variants', async () => {
    const groups = await errorGroups(scope, range, 'uploads-get');
    expect(groups.map((g) => [g.error_type, g.error_template, g.count, g.variants])).toEqual([
      ['Error', 'Upload not found for ID: {path}', 12, 4],
      ['NoSuchKey', 'Upload not found for ID: {path}', 1, 1],
      ['Error', 'Upload not found for ID: {path}', 1, 1],
    ]);
    const [uploads] = groups;
    expect(uploads.first_seen).toBe(new Date(T0).toISOString());
    expect(uploads.top_messages).toHaveLength(4);
    expect(uploads.top_messages[0]).toMatchObject({ message: 'Upload not found for ID: fonts/semibold.woff2', count: 3 });
    expect(uploads.top_messages.map((m) => m.message).sort()).toEqual(PRODUCTION.map((p) => `Upload not found for ID: ${p}`).sort());
    expect(uploads.top_messages.every((m) => /^6aa1c6a0/.test(m.sample_trace_id))).toBe(true);
    expect(new Set(groups.map((g) => g.fingerprint)).size).toBe(3);
  });

  it('keeps init failures apart by module, and groups Stripe IDs without a stack', async () => {
    const groups = await errorGroups(scope, range);
    const of = (fn: string) => groups.filter((g) => g.function === fn).map((g) => [g.error_template, g.count, g.failure_kind]);
    expect(of('reports-export').sort()).toEqual([
      ["Error: Cannot find module 'left-pad'", 1, 'init_failed'],
      ["Error: Cannot find module 'mjml'", 1, 'init_failed'],
    ]);
    expect(of('billing-sync')).toEqual([["No such customer: '{id}'", 2, null]]);
  });

  it('lists the invocations of one group', async () => {
    const [uploads] = await errorGroups(scope, range, 'uploads-get');
    const { items } = await listInvocations(scope, range, { group: uploads.fingerprint });
    expect(items).toHaveLength(12);
    expect(items.every((i) => i.status === 'error' && i.error_message?.startsWith('Upload not found'))).toBe(true);
    await expect(listInvocations(scope, range, { group: 'not a fingerprint' })).rejects.toThrow(/Invalid group/);
  });

  it('marks groups whose template was seen in the week before as seen before', async () => {
    const groups = await clickhouseAlertData.activeGroups(scope, { since: T0 + 27 * MIN, notified: new Map(), throttles: false });
    const mail = groups.filter((g) => g.function === 'mail-send').map((g) => [g.error_template, g.seen_before, g.total]);
    expect(mail.sort()).toEqual([
      ['Mailbox full for {email}', true, 1],
      ['Quota exceeded for {num} recipients', false, 1],
    ]);
    // Groups without a recent occurrence are not candidates.
    expect(groups.some((g) => g.function === 'uploads-get')).toBe(false);
  });

  it('reports a regrouped template in the digest with its first occurrence under any fingerprint', async () => {
    const data = await clickhouseAlertData.digest({ tenant, projectId: null }, { from: T0 - DAY, to: T0 + DAY });
    const mailbox = data.groups.find((g) => g.error_template === 'Mailbox full for {email}');
    expect(mailbox).toMatchObject({ count: 1, previous: 0, first_seen: T0 - 2 * DAY });
    const uploads = data.groups.find((g) => g.function === 'uploads-get' && g.count === 12);
    expect(uploads).toMatchObject({ variants: 4, error_template: 'Upload not found for ID: {path}' });
  });
});
