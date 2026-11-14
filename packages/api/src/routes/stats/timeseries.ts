import type { Context } from 'hono';
import { timeseries } from '../../lib/data/timeseries.js';
import { dataScopeOf } from '../../lib/tenancy/context.js';
import { parseTimeRange } from '../../lib/utils/time-range.js';

export async function getTimeseries(c: Context) {
  const params = c.req.query();
  const items = await timeseries(dataScopeOf(c), parseTimeRange(params), { function: params.function, bucket: params.bucket });
  return c.json({ items });
}
