import type { Context } from 'hono';
import { dataQuery } from '../../lib/tenancy/context.js';
import { isoFromMs } from '../../lib/utils/format.js';
import { parseTimeRange } from '../../lib/utils/time-range.js';

interface ErrorGroupRow {
  fingerprint: string;
  function: string;
  error_type: string;
  error_message: string;
  count: number;
  first_seen_ms: number;
  last_seen_ms: number;
  sample_trace_id: string;
}

export async function getErrors(c: Context) {
  const params = c.req.query();
  const range = parseTimeRange(params);
  const rows = await dataQuery<ErrorGroupRow>(
    c,
    `SELECT error_fingerprint AS fingerprint, function,
       argMax(error_type, ts) AS error_type,
       argMax(error_message, ts) AS error_message,
       count() AS count,
       toUnixTimestamp64Milli(min(ts)) AS first_seen_ms,
       toUnixTimestamp64Milli(max(ts)) AS last_seen_ms,
       argMax(trace_id, ts) AS sample_trace_id
     FROM invocations
     WHERE tenant_id = {tenant:String}
       AND ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})
       AND status = 'error'
       ${params.function ? 'AND function = {function:String}' : ''}
     GROUP BY fingerprint, function
     ORDER BY count DESC, last_seen_ms DESC
     LIMIT 500`,
    { from: range.from, to: range.to, function: params.function ?? '' },
  );

  return c.json({
    items: rows.map((row) => ({
      fingerprint: row.fingerprint,
      function: row.function,
      error_type: row.error_type || 'Error',
      error_message: row.error_message,
      count: row.count,
      first_seen: isoFromMs(row.first_seen_ms),
      last_seen: isoFromMs(row.last_seen_ms),
      sample_trace_id: row.sample_trace_id,
    })),
  });
}
