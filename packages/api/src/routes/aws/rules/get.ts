import type { Context } from 'hono';
import { presentRule } from '../../../lib/aws/present.js';
import { projectSlugs } from '../../../lib/aws/requests.js';
import { awsStore } from '../../../lib/aws/store.js';
import { tenantOf } from '../../../lib/tenancy/context.js';

export async function getRules(c: Context) {
  const tenant = tenantOf(c).id;
  const [rules, slugs] = await Promise.all([awsStore().listRules(tenant), projectSlugs(tenant)]);
  return c.json({ items: rules.map((r) => presentRule(r, slugs)) });
}
