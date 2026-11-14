import type { Context } from 'hono';
import { getTrace as loadTrace } from '../../lib/data/traces.js';
import { traceResponse } from '../../lib/format/text-trace.js';
import { dataScopeOf } from '../../lib/tenancy/context.js';

export async function getTrace(c: Context) {
  const trace = await loadTrace(dataScopeOf(c), c.req.param('traceId') ?? '');
  return trace ? traceResponse(c, trace) : c.json({ error: 'Trace not found' }, 404);
}
