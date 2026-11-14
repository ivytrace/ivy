import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { shardClient } from '../clickhouse/client.js';
import { insertRows } from '../clickhouse/scoped.js';
import { lookupTenant } from '../tenancy/context.js';
import { assumeRole } from './clients.js';
import type { AwsAccount, FunctionStatus, ThrottleStatus } from './types.js';

const MINUTE = 60_000;
/** How often an account is polled. */
export const THROTTLE_POLL_INTERVAL_MS = 5 * MINUTE;
/** CloudWatch datapoints can land a few minutes late: every poll re-reads this much before the watermark. */
const LOOKBACK_MS = 10 * MINUTE;
/** First poll, or after a long gap (account was disabled, Ivy was down). */
const MAX_WINDOW_MS = 3 * 60 * MINUTE;
const MAX_QUERIES_PER_REQUEST = 500;

export interface ThrottleRow {
  tenant_id: string;
  function: string;
  region: string;
  minute: number;
  account_id: string;
  throttles: number;
}

export interface ThrottleSink {
  save(tenant: string, rows: ThrottleRow[]): Promise<void>;
}

const clickhouseSink: ThrottleSink = {
  async save(tenant, rows) {
    const target = await lookupTenant(tenant);
    if (!target) return;
    const updated = new Date().toISOString();
    await insertRows(
      shardClient(target.shardId),
      'function_throttles',
      rows.map((r) => ({ ...r, minute: Math.floor(r.minute / 1000), updated_at: updated })),
    );
  },
};

let sink: ThrottleSink = clickhouseSink;
export const setThrottleSinkForTests = (s: ThrottleSink | undefined) => {
  sink = s ?? clickhouseSink;
};

export const throttlePollDue = (account: AwsAccount, now = Date.now()) =>
  account.throttle_metrics !== false && now - (account.throttles_polled_to || 0) >= THROTTLE_POLL_INTERVAL_MS;

export function pollWindow(account: AwsAccount, now = Date.now()): { from: number; to: number } {
  const to = Math.floor(now / MINUTE) * MINUTE;
  const from = Math.max((account.throttles_polled_to || 0) - LOOKBACK_MS, to - MAX_WINDOW_MS);
  return { from, to };
}

const isAccessDenied = (err: unknown) => {
  const name = (err as Error)?.name ?? '';
  return name === 'AccessDenied' || name === 'AccessDeniedException' || /not authorized to perform: cloudwatch:GetMetricData/i.test(String((err as Error)?.message));
};

const throttlesQuery = (id: string, functionName?: string): MetricDataQuery => ({
  Id: id,
  ReturnData: true,
  MetricStat: {
    Metric: {
      Namespace: 'AWS/Lambda',
      MetricName: 'Throttles',
      Dimensions: functionName ? [{ Name: 'FunctionName', Value: functionName }] : [],
    },
    Period: 60,
    Stat: 'Sum',
  },
});

/** Runs the queries in requests of at most 500, following NextToken. Returns non-zero points per query ID. */
async function getMetricData(cw: CloudWatchClient, queries: MetricDataQuery[], from: number, to: number) {
  const out = new Map<string, { ts: number; value: number }[]>();
  for (let i = 0; i < queries.length; i += MAX_QUERIES_PER_REQUEST) {
    let token: string | undefined;
    do {
      const res = await cw.send(
        new GetMetricDataCommand({
          MetricDataQueries: queries.slice(i, i + MAX_QUERIES_PER_REQUEST),
          StartTime: new Date(from),
          EndTime: new Date(to),
          NextToken: token,
        }),
      );
      for (const r of res.MetricDataResults ?? []) {
        const points = out.get(r.Id ?? '') ?? [];
        (r.Timestamps ?? []).forEach((t, j) => {
          const value = r.Values?.[j] ?? 0;
          if (value > 0) points.push({ ts: new Date(t).getTime(), value });
        });
        out.set(r.Id ?? '', points);
      }
      token = res.NextToken;
    } while (token);
  }
  return out;
}

/**
 * One region: the account-level Throttles metric first (one metric per poll); only when it shows
 * throttles, the per-function metric for the functions Ivy traces, limited to the throttled minutes.
 */
export async function pollRegionThrottles(
  cw: CloudWatchClient,
  account: AwsAccount,
  region: string,
  traced: string[],
  window: { from: number; to: number },
): Promise<ThrottleRow[]> {
  const total = (await getMetricData(cw, [throttlesQuery('account')], window.from, window.to)).get('account') ?? [];
  if (!total.length || !traced.length) return [];
  const first = Math.min(...total.map((p) => p.ts));
  const last = Math.max(...total.map((p) => p.ts));
  const results = await getMetricData(
    cw,
    traced.map((name, i) => throttlesQuery(`f${i}`, name)),
    first,
    last + MINUTE,
  );
  const rows: ThrottleRow[] = [];
  traced.forEach((name, i) => {
    for (const p of results.get(`f${i}`) ?? []) {
      rows.push({ tenant_id: account.tenant_id, function: name, region, minute: p.ts, account_id: account.account_id, throttles: Math.round(p.value) });
    }
  });
  return rows;
}

export interface ThrottlePollResult {
  throttle_status: ThrottleStatus;
  throttles_polled_to: number;
  error?: string;
}

/**
 * Polls every region of the account and stores per-function, per-minute throttle counts.
 * A role without cloudwatch:GetMetricData (stacks created before Ivy asked for it) is reported as
 * `missing_permission` and doesn't fail the sync.
 */
export async function pollAccountThrottles(
  account: AwsAccount,
  regions: string[],
  functions: FunctionStatus[],
  now = Date.now(),
): Promise<ThrottlePollResult> {
  const window = pollWindow(account, now);
  const credentials = await assumeRole(account);
  const errors: string[] = [];
  let denied = false;
  const rows: ThrottleRow[] = [];
  for (const region of regions) {
    const traced = functions.filter((f) => f.region === region && f.state === 'traced').map((f) => f.function_name);
    // Only regions with traced functions: throttles of other functions aren't stored anyway.
    if (!traced.length) continue;
    try {
      const cw = new CloudWatchClient({ region, credentials, maxAttempts: 3 });
      rows.push(...(await pollRegionThrottles(cw, account, region, traced, window)));
    } catch (err) {
      if (isAccessDenied(err)) {
        denied = true;
        break;
      }
      errors.push(`${region}: ${(err as Error).message}`);
    }
  }
  if (denied) return { throttle_status: 'missing_permission', throttles_polled_to: account.throttles_polled_to || 0 };
  if (rows.length) await sink.save(account.tenant_id, rows);
  if (errors.length) return { throttle_status: 'error', throttles_polled_to: account.throttles_polled_to || 0, error: errors.join('\n') };
  return { throttle_status: 'ok', throttles_polled_to: window.to };
}
