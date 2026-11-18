import type { Context } from 'hono';
import { attributeKeys } from '../../lib/data/attribute-keys.js';
import { dataScopeOf } from '../../lib/tenancy/context.js';
import { parseTimeRange } from '../../lib/utils/time-range.js';

/** Project-scoped, or workspace-wide (all projects). */
export async function getInvocationAttributes(c: Context) {
  return c.json({ items: await attributeKeys(dataScopeOf(c), parseTimeRange(c.req.query())) });
}
