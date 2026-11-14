import type { Context } from 'hono';
import { listInvocations } from '../../lib/data/invocations.js';
import { dataScopeOf } from '../../lib/tenancy/context.js';
import { parseTimeRange } from '../../lib/utils/time-range.js';

export async function getInvocations(c: Context) {
  const params = c.req.query();
  return c.json(await listInvocations(dataScopeOf(c), parseTimeRange(params), params));
}
