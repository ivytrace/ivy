import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setClientsForTests } from '../clickhouse/client.js';
import { schemaStatements } from '../clickhouse/test-schema.js';
import { attributeKeys } from './attribute-keys.js';
import { listInvocations } from './invocations.js';

/**
 * Runs the real schema in a throwaway database, so it needs a ClickHouse server:
 *   IVY_TEST_CLICKHOUSE_URL=http://localhost:8123 pnpm --filter @ivy/api test invocation-search
 * (credentials from IVY_CLICKHOUSE_USER / IVY_CLICKHOUSE_PASSWORD, default ivy/ivy). Skipped without it.
 */
const url = process.env.IVY_TEST_CLICKHOUSE_URL;
const db = `ivy_test_search_${process.pid}_${Date.now()}`;
const tenant = { id: 'ten_test', shardId: 'shard-1' };
const scope = { tenant, projectId: 'prj_test' };
const T0 = Date.UTC(2026, 10, 14, 10, 0, 0);
let admin: ClickHouseClient;

function span(trace: string, id: string, parent: string, startMs: number, attributes: Record<string, string>, projectId = scope.projectId) {
  return {
    TenantId: tenant.id,
    ProjectId: projectId,
    Timestamp: new Date(startMs).toISOString().replace('T', ' ').replace('Z', ''),
    TraceId: trace,
    SpanId: id,
    ParentSpanId: parent,
    SpanName: parent ? 'job' : 'queue-worker',
    SpanKind: 'Internal',
    ServiceName: 'queue-worker',
    ResourceAttributes: { 'faas.name': 'queue-worker', 'cloud.region': 'eu-west-1' },
    SpanAttributes: attributes,
    Duration: 1e6,
    StatusCode: 'Unset',
    StatusMessage: '',
  };
}

const invocation = (requestId: string) => ({ 'ivy.invocation': 'true', 'faas.invocation_id': requestId, 'ivy.trigger.source': 'aws:sqs' });

describe.skipIf(!url)('invocation search by span attribute in ClickHouse', () => {
  const a = { trace: '6aa1c6a0' + 'a'.repeat(24), span: 'aaaaaaaaaaaaaaaa' };
  const b = { trace: '6aa1c6a0' + 'b'.repeat(24), span: 'bbbbbbbbbbbbbbbb' };
  const other = { trace: '6aa1c6a0' + 'c'.repeat(24), span: 'cccccccccccccccc' };

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
    // Two SQS invocations with one child span per record, and the same job ID in another project.
    const rows = [
      span(a.trace, a.span, '', T0, { ...invocation('req-a'), 'messaging.batch.message_count': '2' }),
      span(a.trace, 'a000000000000001', a.span, T0 + 5, { 'job.id': 'msg-1', 'job.task': 'import', 'job.reason': 'manual retry', 'job.attempt': '3', 'ivy.payload.request': '{}' }),
      span(a.trace, 'a000000000000002', a.span, T0 + 9, { 'job.id': 'msg-2', 'job.task': 'export', 'job.urgent': 'true' }),
      span(b.trace, b.span, '', T0 + 1000, invocation('req-b')),
      span(b.trace, 'b000000000000001', b.span, T0 + 1005, { 'job.id': 'msg-3', 'job.task': 'import' }),
      span(other.trace, other.span, '', T0 + 2000, invocation('req-c'), 'prj_other'),
      span(other.trace, 'c000000000000001', other.span, T0 + 2005, { 'job.id': 'msg-1' }, 'prj_other'),
    ];
    await admin.insert({ table: `${db}.otel_traces`, values: rows, format: 'JSONEachRow' });
  }, 60_000);

  afterAll(async () => {
    setClientsForTests(undefined);
    await admin?.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin?.close();
  });

  const range = { from: T0 - 3_600_000, to: T0 + 3_600_000 };
  const search = async (q: string) => (await listInvocations(scope, range, { q })).items.map((i) => i.request_id);

  it("finds the invocation by a child span's attribute, within the project", async () => {
    expect(await search('job.id=msg-1')).toEqual(['req-a']);
    expect(await search('job.id=msg-3')).toEqual(['req-b']);
    expect(await search('job.task=import')).toEqual(['req-b', 'req-a']);
    expect(await search('job.id=nope')).toEqual([]);
    const all = await listInvocations({ tenant, projectId: null }, range, { q: 'job.id=msg-1' });
    expect(all.items.map((i) => i.request_id)).toEqual(['req-c', 'req-a']);
  });

  it("matches the invocation span's own attributes, numbers and booleans as strings, and quoted values", async () => {
    expect(await search('messaging.batch.message_count=2')).toEqual(['req-a']);
    expect(await search('job.attempt=3 job.urgent=true')).toEqual(['req-a']);
    expect(await search('job.reason="manual retry"')).toEqual(['req-a']);
  });

  it('requires every term, each on any span, and combines with free text', async () => {
    expect(await search('job.id=msg-1 job.task=export')).toEqual(['req-a']);
    expect(await search('job.id=msg-3 job.task=export')).toEqual([]);
    expect(await search('job.task=import req-b')).toEqual(['req-b']);
    expect(await search('job.task=import req-c')).toEqual([]);
  });

  it('lists the attribute keys in use, most used first, without payload attributes', async () => {
    const keys = await attributeKeys(scope, range);
    expect(keys.slice(0, 5)).toEqual([
      { key: 'job.id', spans: 3 },
      { key: 'job.task', spans: 3 },
      { key: 'faas.invocation_id', spans: 2 },
      { key: 'ivy.invocation', spans: 2 },
      { key: 'ivy.trigger.source', spans: 2 },
    ]);
    expect(keys.map((k) => k.key)).not.toContain('ivy.payload.request');
    expect((await attributeKeys({ tenant, projectId: null }, range))[0]).toEqual({ key: 'job.id', spans: 4 });
    // Only the last 24 hours of a longer range are read.
    expect(await attributeKeys(scope, { from: T0 - 3_600_000, to: T0 + 3 * 86_400_000 })).toEqual([]);
  });
});
