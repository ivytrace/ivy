import type { Context } from 'hono';
import { jsonBody } from '../../lib/aws/requests.js';
import { tenantOf } from '../../lib/tenancy/context.js';
import { createProject, presentProject } from '../../lib/tenancy/projects.js';

/** `{ "name": "Checkout (prod)", "slug"?: "checkout-prod" }`; the slug defaults to one made from the name. */
export async function postProject(c: Context) {
  return c.json(presentProject(await createProject(tenantOf(c).id, await jsonBody(c))), 201);
}
