import type { Context } from 'hono';
import { presentRule } from '../../../lib/aws/present.js';
import { jsonBody, projectSlugs } from '../../../lib/aws/requests.js';
import { createRule, parseMatcher, resyncWorkspace } from '../../../lib/aws/rules.js';
import { tenantOf } from '../../../lib/tenancy/context.js';
import { createProject, findProject, presentProject } from '../../../lib/tenancy/projects.js';
import { badRequest } from '../../../lib/utils/http-error.js';

/** Creates a rule (optionally with a new project) and re-syncs, so matching functions get traced now. */
export async function postRule(c: Context) {
  const tenant = tenantOf(c).id;
  const body = await jsonBody(c);
  parseMatcher(body.matcher);
  let projectRef = body.project;
  if (body.new_project !== undefined) {
    if (!body.new_project || typeof body.new_project !== 'object') throw badRequest('new_project must be { name, slug? }');
    projectRef = (await createProject(tenant, body.new_project as Record<string, unknown>)).id;
  }
  const rule = await createRule(tenant, { ...body, project: projectRef });
  await resyncWorkspace(tenant);
  const project = await findProject(tenant, rule.project_id);
  return c.json({ rule: presentRule(rule, await projectSlugs(tenant)), project: project && presentProject(project) }, 201);
}
