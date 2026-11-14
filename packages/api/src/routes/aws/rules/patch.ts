import type { Context } from 'hono';
import { presentRule } from '../../../lib/aws/present.js';
import { jsonBody, projectSlugs } from '../../../lib/aws/requests.js';
import { resyncWorkspace, updateRule } from '../../../lib/aws/rules.js';
import { tenantOf } from '../../../lib/tenancy/context.js';

export async function patchRule(c: Context) {
  const tenant = tenantOf(c).id;
  const rule = await updateRule(tenant, c.req.param('id') ?? '', await jsonBody(c));
  await resyncWorkspace(tenant);
  return c.json(presentRule(rule, await projectSlugs(tenant)));
}
