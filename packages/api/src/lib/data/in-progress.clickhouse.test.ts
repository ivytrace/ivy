import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setClientsForTests } from '../clickhouse/client.js';
import { schemaStatements } from '../clickhouse/test-schema.js';
import { clearUsageCacheForTests, countMonthlyTraces } from '../limits/usage.js';
import { listInvocations } from './invocations.js';
import { getTrace } from './traces.js';

/**
 * Runs the real schema (materialized views included) in a throwaway database, so it needs a ClickHouse server:
 *   IVY_TEST_CLICKHOUSE_URL=http://localhost:8123 pnpm --filter @ivy/api test in-progress
 * (credentials from IVY_CLICKHOUSE_USER / IVY_CLICKHOUSE_PASSWORD, default ivy/ivy). Skipped without it.
 */
const url = process.env.IVY_TEST_CLICKHOUSE_URL;
const db = `ivy_test_${process.pid}_${Date.now()}`;
const tenant = { id: 'ten_test', shardId: 'shard-1' };
const scope = { tenant, projectId: 'prj_test' };
const T0 = Date.UTC(2026, 10, 14, 10, 0, 0);
let admin: ClickHouseClient;

interface Span {
  trace: string;
  span: string;
  startMs: number;
  durationMs: number;
  requestId: string;
  inProgress?: { deadlineMs: number; lastSeenMs: number };
}

function row(s: Span) {
  const attributes: Record<string, string> = { 'ivy.invocation': 'true', 'faas.invocation_id': s.requestId, 'faas.coldstart': 'false' };
  if (s.inProgress) {
    attributes['ivy.in_progress'] = 'true';
    attributes['ivy.deadline_ms'] = String(s.inProgress.deadlineMs);
    attributes['ivy.last_seen_ms'] = String(s.inProgress.lastSeenMs);
  } else {
    attributes['ivy.trigger.source'] = 'aws:sqs';
  }
  return {
    TenantId: tenant.id,
    ProjectId: scope.projectId,
    Timestamp: new Date(s.startMs).toISOString().replace('T', ' ').replace('Z', ''),
    TraceId: s.trace,
    SpanId: s.span,
    ParentSpanId: '',
    SpanName: 'import-worker',
    SpanKind: 'Internal',
    ServiceName: 'import-worker',
    ResourceAttributes: { 'faas.name': 'import-worker', 'cloud.region': 'eu-west-1' },
    SpanAttributes: attributes,
    Duration: s.durationMs * 1e6,
    StatusCode: 'Unset',
    StatusMessage: '',
  };
}

describe.skipIf(!url)('in-progress invocations in ClickHouse', () => {
  const long = { trace: '6aa1c6a0' + 'a'.repeat(24), span: 'aaaaaaaaaaaaaaaa', requestId: 'req-long' };
  const orphan = { trace: '6aa1c6a0' + 'c'.repeat(24), span: 'cccccccccccccccc', requestId: 'req-orphan' };
  const deadlineMs = T0 + 900_000;

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
    clearUsageCacheForTests();
    // A 7 s invocation: reported in progress after 5 s, refreshed once, then its final span. Plus an ordinary
    // invocation, and one whose final span never came (the environment died).
    const spans: Span[] = [
      { ...long, startMs: T0, durationMs: 5000, inProgress: { deadlineMs, lastSeenMs: T0 + 5000 } },
      { ...long, startMs: T0, durationMs: 6000, inProgress: { deadlineMs, lastSeenMs: T0 + 6000 } },
      { ...long, startMs: T0 + 3, durationMs: 7000 },
      { trace: '6aa1c6a0' + 'b'.repeat(24), span: 'bbbbbbbbbbbbbbbb', requestId: 'req-short', startMs: T0 + 1000, durationMs: 40 },
      { ...orphan, startMs: T0 + 2000, durationMs: 5000, inProgress: { deadlineMs: T0 + 62_000, lastSeenMs: T0 + 7000 } },
    ];
    for (const s of spans) await admin.insert({ table: `${db}.otel_traces`, values: [row(s)], format: 'JSONEachRow' });
  }, 60_000);

  afterAll(async () => {
    setClientsForTests(undefined);
    await admin?.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin?.close();
  });

  const range = { from: T0 - 3_600_000, to: T0 + 3_600_000 };

  it('counts the invocation reported in progress once for billing, and not the orphaned record', async () => {
    expect(await countMonthlyTraces(tenant, '2026-11', T0 + 7_200_000)).toBe(2);
    const rows = await (await admin.query({ query: `SELECT span_id FROM ${db}.invocations ORDER BY span_id`, format: 'JSONEachRow' })).json<{ span_id: string }>();
    expect(rows.map((r) => r.span_id)).toEqual([long.span, 'bbbbbbbbbbbbbbbb']);
  });

  it('lists the final row instead of the in-progress one, and in-progress rows that have no final yet', async () => {
    const { items } = await listInvocations(scope, range, {});
    expect(items.map((i) => [i.span_id, i.status])).toEqual([
      [orphan.span, 'in_progress'],
      ['bbbbbbbbbbbbbbbb', 'ok'],
      [long.span, 'ok'],
    ]);
    const pending = items[0];
    expect(pending).toMatchObject({ deadline: new Date(T0 + 62_000).toISOString(), last_seen: new Date(T0 + 7000).toISOString(), duration_ms: 5000 });
    expect((await listInvocations(scope, range, { status: 'in_progress' })).items.map((i) => i.span_id)).toEqual([orphan.span]);
    expect((await listInvocations(scope, range, { status: 'ok' })).items.map((i) => i.span_id)).toEqual(['bbbbbbbbbbbbbbbb', long.span]);
    expect((await listInvocations(scope, range, { ids: `${long.span},${orphan.span}` })).items.map((i) => [i.span_id, i.status])).toEqual([
      [orphan.span, 'in_progress'],
      [long.span, 'ok'],
    ]);
    expect((await listInvocations(scope, range, { q: 'req-orphan' })).items).toHaveLength(1);
  });

  it('shows the final invocation span on the trace page, or the latest in-progress record', async () => {
    const done = await getTrace(scope, long.trace);
    expect(done?.spans).toHaveLength(1);
    expect(done?.spans[0].attributes['ivy.in_progress']).toBeUndefined();
    const pending = await getTrace(scope, orphan.trace);
    expect(pending?.spans.map((s) => s.attributes['ivy.last_seen_ms'])).toEqual([String(T0 + 7000)]);
  });
});
