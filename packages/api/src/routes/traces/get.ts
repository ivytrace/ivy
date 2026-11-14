import type { Context } from 'hono';
import { getTrace as loadTrace } from '../../lib/data/traces.js';
import { dataScopeOf } from '../../lib/tenancy/context.js';

export async function getTrace(c: Context) {
  const trace = await loadTrace(dataScopeOf(c), c.req.param('traceId') ?? '');
  return trace ? c.json(trace) : c.json({ error: 'Trace not found' }, 404);
}
