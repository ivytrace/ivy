import type { Context } from 'hono';
import { presentRule } from '../../../lib/aws/present.js';
import { jsonBody, projectSlugs } from '../../../lib/aws/requests.js';
import { reorderRules, resyncWorkspace } from '../../../lib/aws/rules.js';
import { tenantOf } from '../../../lib/tenancy/context.js';

export async function putRuleOrder(c: Context) {
  const tenant = tenantOf(c).id;
  const rules = await reorderRules(tenant, (await jsonBody(c)).order);
  await resyncWorkspace(tenant);
  const slugs = await projectSlugs(tenant);
  return c.json({ items: rules.map((r) => presentRule(r, slugs)) });
}
