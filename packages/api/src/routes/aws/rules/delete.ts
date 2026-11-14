import type { Context } from 'hono';
import { deleteRule, resyncWorkspace } from '../../../lib/aws/rules.js';
import { tenantOf } from '../../../lib/tenancy/context.js';

export async function deleteRuleRoute(c: Context) {
  const tenant = tenantOf(c).id;
  await deleteRule(tenant, c.req.param('id') ?? '');
  await resyncWorkspace(tenant);
  return c.json({ deleted: true });
}
