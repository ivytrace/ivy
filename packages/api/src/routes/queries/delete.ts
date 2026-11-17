import type { Context } from 'hono';
import { authUser } from '../../lib/auth/user.js';
import { deleteSavedQuery } from '../../lib/query/saved.js';
import { tenantOf } from '../../lib/tenancy/context.js';

export async function deleteSavedQueryRoute(c: Context) {
  await deleteSavedQuery(tenantOf(c).id, c.req.param('id') ?? '', authUser(c)?.email ?? '');
  return c.json({ deleted: true });
}
