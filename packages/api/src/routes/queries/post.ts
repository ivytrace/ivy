import type { Context } from 'hono';
import { authUser } from '../../lib/auth/user.js';
import { jsonBody } from '../../lib/aws/requests.js';
import { createSavedQuery, presentSavedQuery } from '../../lib/query/saved.js';
import { tenantOf } from '../../lib/tenancy/context.js';

/** `{ "name": "Slowest routes", "sql": "SELECT …" }`. */
export async function postSavedQuery(c: Context) {
  const query = await createSavedQuery(tenantOf(c).id, await jsonBody(c), authUser(c)?.email ?? '');
  return c.json(presentSavedQuery(query), 201);
}
