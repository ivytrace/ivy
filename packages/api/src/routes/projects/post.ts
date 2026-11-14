import type { Context } from 'hono';
import { jsonBody } from '../../lib/aws/requests.js';
import { tenantOf } from '../../lib/tenancy/context.js';
import { createProject, presentProject } from '../../lib/tenancy/projects.js';

/** `{ "name": "Checkout (prod)", "slug"?: "checkout-prod" }`; the slug defaults to one made from the name. */
export async function postProject(c: Context) {
  const tenant = tenantOf(c).id;
  const project = await createProject(tenant, await jsonBody(c));
  return c.json(presentProject(project), 201);
}
