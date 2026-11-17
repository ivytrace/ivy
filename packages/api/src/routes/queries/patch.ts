import type { Context } from 'hono';
import { authUser } from '../../lib/auth/user.js';
import { jsonBody } from '../../lib/aws/requests.js';
import { presentSavedQuery, updateSavedQuery } from '../../lib/query/saved.js';
import { tenantOf } from '../../lib/tenancy/context.js';

/** `{ "name"?: …, "sql"?: … }`. Any member can change any of the workspace's saved queries. */
export async function patchSavedQuery(c: Context) {
  const query = await updateSavedQuery(tenantOf(c).id, c.req.param('id') ?? '', await jsonBody(c), authUser(c)?.email ?? '');
  return c.json(presentSavedQuery(query));
}
