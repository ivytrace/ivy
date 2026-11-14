import { failureKind, type FailureKind } from '@ivy/spans';
import { projectFilter } from '../clickhouse/scoped.js';
import { THROTTLED_ERROR_TYPE, THROTTLED_MESSAGE } from '../stats/throttles.js';
import { ERROR_GROUP_COLUMNS, ERROR_TEMPLATE_SQL } from '../data/error-grouping.js';
import { queryScope, scopedDataQuery, type DataScope } from '../tenancy/context.js';

/** An error group as the alert evaluator sees it (the fingerprints of lib/data/errors.ts). */
export interface AlertGroup {
  fingerprint: string;
  function: string;
  kind: 'error' | 'throttle';
  error_type: string;
  /** The latest raw message. */
  error_message: string;
  /** The message with its variable parts replaced (`errorTemplate`); the message itself for throttles. */
  error_template: string;
  /** Distinct raw messages within retention. */
  variants: number;
  failure_kind: FailureKind | null;
  /**
   * The same function, error type and template had occurrences in the 7 days before the candidate window, possibly
   * under another fingerprint (before code locations were part of it): such a group without state isn't new.
   */
  seen_before: boolean;
  /** The latest occurrence's trace; null for throttles. */
  sample_trace_id: string | null;
  /** Occurrences within retention. */
  total: number;
  first_seen: number;
  last_seen: number;
  /** Occurrences after the group's last notification (all of them when it has none). */
  since_notify: number;
}

/** What a message shows for a group: its template when it has several distinct messages, else the message. */
export const groupMessage = (g: { error_message: string; error_template: string; variants: number }) =>
  g.variants > 1 ? g.error_template : g.error_message;

/** How far back an earlier occurrence of a group's template makes it "seen before" (`AlertGroup.seen_before`). */
export const SEEN_BEFORE_MS = 7 * 24 * 3600_000;

export interface DigestGroup {
  project_id: string;
  fingerprint: string;
  function: string;
  kind: 'error' | 'throttle';
  error_type: string;
  error_message: string;
  error_template: string;
  variants: number;
  failure_kind: FailureKind | null;
  sample_trace_id: string | null;
  count: number;
  previous: number;
  first_seen: number;
}

export interface DigestTotals {
  invocations: number;
  errors: number;
  failures: number;
  throttles: number;
}

export interface DigestData {
  totals: DigestTotals;
  previous: DigestTotals;
  groups: DigestGroup[];
}

/** Reads behind alerts and the digest; tests swap in a fake. */
export interface AlertDataSource {
  /**
   * Groups of one project with an occurrence at or after `since`, with totals within retention and
   * the count after each fingerprint's `notified` time.
   */
  activeGroups(scope: DataScope, opts: { since: number; notified: Map<string, number>; throttles: boolean }): Promise<AlertGroup[]>;
  /** The first stack frame of the error in a trace (`at handler (/var/task/index.mjs:12:5)`), if any. */
  stackLine(scope: DataScope, traceId: string, at: number): Promise<string | null>;
  /** One week of a workspace (all projects) against the week before. */
  digest(scope: DataScope, week: { from: number; to: number }): Promise<DigestData>;
}

/** Error types that mean a failure outside the handler even without `failure_phase` (see @ivy/spans failureKind). */
const OUTSIDE_HANDLER_TYPES = [
  'Runtime.ImportModuleError',
  'Runtime.HandlerNotFound',
  'Runtime.UserCodeSyntaxError',
  'Runtime.MalformedHandlerName',
  'Runtime.OutOfMemory',
  'Sandbox.Timedout',
  'Timeout',
  'Runtime.ExitError',
  'Runtime.Unknown',
];

interface ErrorRow {
  fingerprint: string;
  function: string;
  error_type: string;
  error_template: string;
  latest_message: string;
  variants: number;
  sample_trace_id: string;
  failure_phase: string;
  total: number;
  first_ms: number;
  last_ms: number;
  recent: number;
  prior: number;
  since_notify: number;
}

interface ThrottleRow {
  function: string;
  region: string;
  total: number;
  first_ms: number;
  last_ms: number;
  since_notify: number;
}

const throttleFingerprint = (region: string, fn: string) => `throttled:${region}:${fn}`;

const notifiedParams = (notified: Map<string, number>) => ({
  notified_fps: [...notified.keys()],
  notified_at: [...notified.values()],
});

async function activeGroups(scope: DataScope, opts: { since: number; notified: Map<string, number>; throttles: boolean }): Promise<AlertGroup[]> {
  const q = queryScope(scope);
  const params = { since: opts.since, ...notifiedParams(opts.notified) };
  const errorParams = { ...params, prior_from: opts.since - SEEN_BEFORE_MS };
  const recent = `tenant_id = {tenant:String} ${projectFilter(q, 'project_id')} AND status = 'error' AND ts >= fromUnixTimestamp64Milli({since:Int64})`;
  // Every fingerprint of a (function, error type, template) with a recent occurrence, so `seen_before` also sees
  // older fingerprints of the same template. The (function, error type) filter uses the primary key and keeps the
  // template computation to the rows that can match.
  const errors = await scopedDataQuery<ErrorRow>(
    scope,
    `SELECT fingerprint, function, error_type, error_template,
       argMax(error_message, ts) AS latest_message, uniqExact(error_message) AS variants,
       argMax(trace_id, ts) AS sample_trace_id, argMax(failure_phase, ts) AS failure_phase,
       count() AS total,
       toUnixTimestamp64Milli(min(ts)) AS first_ms, toUnixTimestamp64Milli(max(ts)) AS last_ms,
       countIf(ts >= fromUnixTimestamp64Milli({since:Int64})) AS recent,
       countIf(ts >= fromUnixTimestamp64Milli({prior_from:Int64}) AND ts < fromUnixTimestamp64Milli({since:Int64})) AS prior,
       countIf(toUnixTimestamp64Milli(ts) > {notified_at:Array(Int64)}[indexOf({notified_fps:Array(String)}, fingerprint)]) AS since_notify
     FROM (
       SELECT ts, function, error_type, error_frame, error_message, trace_id, failure_phase, ${ERROR_GROUP_COLUMNS}
       FROM invocations
       WHERE tenant_id = {tenant:String} ${projectFilter(q, 'project_id')} AND status = 'error'
         AND (function, error_type) IN (SELECT DISTINCT function, error_type FROM invocations WHERE ${recent})
     )
     WHERE (function, error_type, error_template) IN (
       SELECT DISTINCT function, error_type, ${ERROR_TEMPLATE_SQL} FROM invocations WHERE ${recent}
     )
     GROUP BY fingerprint, function, error_type, error_template`,
    errorParams,
  );
  const templateKey = (r: ErrorRow) => JSON.stringify([r.function, r.error_type, r.error_template]);
  const seenBefore = new Set(errors.filter((r) => Number(r.prior) > 0).map(templateKey));
  const groups: AlertGroup[] = errors
    .filter((r) => Number(r.recent) > 0)
    .map((r) => ({
      fingerprint: r.fingerprint,
      function: r.function,
      kind: 'error',
      error_type: r.error_type || 'Error',
      error_message: r.latest_message,
      error_template: r.error_template,
      variants: Number(r.variants),
      failure_kind: failureKind(r.error_type, r.failure_phase),
      seen_before: seenBefore.has(templateKey(r)),
      sample_trace_id: r.sample_trace_id || null,
      total: Number(r.total),
      first_seen: Number(r.first_ms),
      last_seen: Number(r.last_ms),
      since_notify: Number(r.since_notify),
    }));
  if (!opts.throttles) return groups;

  const throttled = await scopedDataQuery<ThrottleRow>(
    scope,
    `SELECT function, region, sum(throttles) AS total,
       toUnixTimestamp(min(minute)) * 1000 AS first_ms, toUnixTimestamp(max(minute)) * 1000 AS last_ms,
       sumIf(throttles, toUnixTimestamp(minute) * 1000 > {notified_at:Array(Int64)}[indexOf({notified_fps:Array(String)}, concat('throttled:', region, ':', function))]) AS since_notify
     FROM function_throttles FINAL
     WHERE tenant_id = {tenant:String} ${projectFilter(q, 'project_id')} AND throttles > 0
       AND (function, region) IN (
         SELECT function, region FROM function_throttles FINAL
         WHERE tenant_id = {tenant:String} ${projectFilter(q, 'project_id')} AND throttles > 0
           AND minute >= toDateTime(intDiv({since:Int64}, 1000))
       )
     GROUP BY function, region`,
    params,
  );
  for (const r of throttled) {
    groups.push({
      fingerprint: throttleFingerprint(r.region, r.function),
      function: r.function,
      kind: 'throttle',
      error_type: THROTTLED_ERROR_TYPE,
      error_message: THROTTLED_MESSAGE,
      error_template: THROTTLED_MESSAGE,
      variants: 1,
      failure_kind: null,
      seen_before: false,
      sample_trace_id: null,
      total: Number(r.total),
      first_seen: Number(r.first_ms),
      last_seen: Number(r.last_ms),
      since_notify: Number(r.since_notify),
    });
  }
  return groups;
}

interface TotalsRow {
  previous: number;
  invocations: number;
  errors: number;
  failures: number;
}

interface DigestErrorRow {
  project_id: string;
  fingerprint: string;
  function: string;
  error_type: string;
  error_template: string;
  latest_message: string;
  variants: number;
  sample_trace_id: string;
  failure_phase: string;
  count: number;
  previous: number;
  first_ms: number;
}

async function digest(scope: DataScope, week: { from: number; to: number }): Promise<DigestData> {
  const q = queryScope(scope);
  const prevFrom = week.from - (week.to - week.from);
  const params = { from: week.from, to: week.to, prev_from: prevFrom, outside: OUTSIDE_HANDLER_TYPES };
  const totals = await scopedDataQuery<TotalsRow>(
    scope,
    `SELECT ts < fromUnixTimestamp64Milli({from:Int64}) AS previous,
       count() AS invocations, countIf(status = 'error') AS errors,
       countIf(status = 'error' AND (failure_phase != '' OR error_type IN {outside:Array(String)})) AS failures
     FROM invocations
     WHERE tenant_id = {tenant:String} ${projectFilter(q, 'project_id')}
       AND ts >= fromUnixTimestamp64Milli({prev_from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})
     GROUP BY previous`,
    params,
  );
  const throttles = await scopedDataQuery<{ previous: number; throttles: number }>(
    scope,
    `SELECT minute < toDateTime(intDiv({from:Int64}, 1000)) AS previous, sum(throttles) AS throttles
     FROM function_throttles FINAL
     WHERE tenant_id = {tenant:String} ${projectFilter(q, 'project_id')}
       AND minute >= toDateTime(intDiv({prev_from:Int64}, 1000)) AND minute < toDateTime(intDiv({to:Int64}, 1000))
     GROUP BY previous`,
    params,
  );
  const totalsOf = (previous: boolean): DigestTotals => {
    const t = totals.find((r) => !!Number(r.previous) === previous);
    const th = throttles.find((r) => !!Number(r.previous) === previous);
    return {
      invocations: Number(t?.invocations ?? 0),
      errors: Number(t?.errors ?? 0),
      failures: Number(t?.failures ?? 0),
      throttles: Number(th?.throttles ?? 0),
    };
  };

  // Groups seen this week, with last week's count and the first occurrence of their template within retention
  // (under any fingerprint, so groups whose fingerprint changed aren't reported as new).
  const rows = await scopedDataQuery<DigestErrorRow>(
    scope,
    `SELECT * FROM (
       SELECT *, min(group_first_ms) OVER (PARTITION BY project_id, function, error_type, error_template) AS first_ms
       FROM (
         SELECT project_id, fingerprint, function, error_type, error_template,
           argMax(error_message, ts) AS latest_message, uniqExact(error_message) AS variants,
           argMax(trace_id, ts) AS sample_trace_id, argMax(failure_phase, ts) AS failure_phase,
           countIf(ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})) AS count,
           countIf(ts >= fromUnixTimestamp64Milli({prev_from:Int64}) AND ts < fromUnixTimestamp64Milli({from:Int64})) AS previous,
           toUnixTimestamp64Milli(min(ts)) AS group_first_ms
         FROM (
           SELECT project_id, ts, function, error_type, error_frame, error_message, trace_id, failure_phase, ${ERROR_GROUP_COLUMNS}
           FROM invocations
           WHERE tenant_id = {tenant:String} ${projectFilter(q, 'project_id')} AND status = 'error'
             AND ts < fromUnixTimestamp64Milli({to:Int64})
         )
         GROUP BY project_id, fingerprint, function, error_type, error_template
       )
     )
     WHERE count > 0
     ORDER BY count DESC
     LIMIT 200`,
    params,
  );
  const groups: DigestGroup[] = rows.map((r) => ({
    project_id: r.project_id,
    fingerprint: r.fingerprint,
    function: r.function,
    kind: 'error',
    error_type: r.error_type || 'Error',
    error_message: r.latest_message,
    error_template: r.error_template,
    variants: Number(r.variants),
    failure_kind: failureKind(r.error_type, r.failure_phase),
    sample_trace_id: r.sample_trace_id || null,
    count: Number(r.count),
    previous: Number(r.previous),
    first_seen: Number(r.first_ms),
  }));

  const throttledFns = await scopedDataQuery<{ project_id: string; function: string; region: string; count: number; previous: number; first_ms: number }>(
    scope,
    `SELECT project_id, function, region,
       sumIf(throttles, minute >= toDateTime(intDiv({from:Int64}, 1000))) AS count,
       sumIf(throttles, minute >= toDateTime(intDiv({prev_from:Int64}, 1000)) AND minute < toDateTime(intDiv({from:Int64}, 1000))) AS previous,
       toUnixTimestamp(min(minute)) * 1000 AS first_ms
     FROM function_throttles FINAL
     WHERE tenant_id = {tenant:String} ${projectFilter(q, 'project_id')} AND throttles > 0
       AND minute < toDateTime(intDiv({to:Int64}, 1000))
     GROUP BY project_id, function, region
     HAVING count > 0`,
    params,
  );
  for (const r of throttledFns) {
    groups.push({
      project_id: r.project_id,
      fingerprint: throttleFingerprint(r.region, r.function),
      function: r.function,
      kind: 'throttle',
      error_type: THROTTLED_ERROR_TYPE,
      error_message: THROTTLED_MESSAGE,
      error_template: THROTTLED_MESSAGE,
      variants: 1,
      failure_kind: null,
      sample_trace_id: null,
      count: Number(r.count),
      previous: Number(r.previous),
      first_seen: Number(r.first_ms),
    });
  }
  groups.sort((a, b) => b.count - a.count);
  return { totals: totalsOf(false), previous: totalsOf(true), groups };
}

/** The first `at …` line of a stack trace (a frame, never the message, which may repeat payload data). */
export function firstFrame(stack: string): string | null {
  const line = stack.split('\n').map((l) => l.trim()).find((l) => /^at\s/.test(l) || /^File "/.test(l));
  return line ? line.slice(0, 200) : null;
}

async function stackLine(scope: DataScope, traceId: string, at: number): Promise<string | null> {
  const rows = await scopedDataQuery<{ stack: string }>(
    scope,
    `SELECT arrayFirst(s -> s != '', arrayMap(a -> a['exception.stacktrace'], \`Events.Attributes\`)) AS stack
     FROM otel_traces
     WHERE TenantId = {tenant:String} ${projectFilter(queryScope(scope), 'ProjectId')} AND TraceId = {trace_id:String}
       AND Timestamp >= toDateTime({lo:UInt32}) AND Timestamp <= toDateTime({hi:UInt32}) AND StatusCode = 'Error'
     ORDER BY Timestamp
     LIMIT 20`,
    { trace_id: traceId, lo: Math.floor(at / 1000) - 3600, hi: Math.floor(at / 1000) + 3600 },
  );
  for (const r of rows) {
    const frame = r.stack ? firstFrame(r.stack) : null;
    if (frame) return frame;
  }
  return null;
}

export const clickhouseAlertData: AlertDataSource = { activeGroups, stackLine, digest };

let current: AlertDataSource = clickhouseAlertData;
export const alertData = () => current;
export function setAlertDataForTests(source: AlertDataSource | undefined) {
  current = source ?? clickhouseAlertData;
}
