import type { Context } from 'hono';
import { listSavedQueries, presentSavedQuery } from '../../lib/query/saved.js';
import { tenantOf } from '../../lib/tenancy/context.js';

/** The workspace's saved queries (the defaults included, until deleted), oldest first. */
export async function getSavedQueries(c: Context) {
  return c.json({ items: (await listSavedQueries(tenantOf(c).id)).map(presentSavedQuery) });
}
