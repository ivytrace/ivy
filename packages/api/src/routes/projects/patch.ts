import type { Context } from 'hono';
import { jsonBody } from '../../lib/aws/requests.js';
import { resyncWorkspace } from '../../lib/aws/rules.js';
import { projectOf } from '../../lib/tenancy/context.js';
import { presentProject, updateProject } from '../../lib/tenancy/projects.js';

/** Any of `name`, `slug`, `archived`. Archiving re-syncs AWS accounts so its functions stop sending to it. */
export async function patchProject(c: Context) {
  const project = projectOf(c);
  const body = await jsonBody(c);
  const next = await updateProject(project, body);
  if (next.archived !== project.archived) await resyncWorkspace(project.tenant_id);
  return c.json(presentProject(next));
}
