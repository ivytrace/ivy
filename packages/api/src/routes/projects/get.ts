import type { Context } from 'hono';
import { projectOf, tenantOf } from '../../lib/tenancy/context.js';
import { defaultProjectOf, listProjects, presentProject } from '../../lib/tenancy/projects.js';

/** The workspace's projects; `?archived=1` includes archived ones. */
export async function getProjects(c: Context) {
  const archived = c.req.query('archived') === '1';
  const projects = (await listProjects(tenantOf(c).id)).filter((p) => archived || !p.archived);
  const defaultId = await defaultProjectOf(tenantOf(c).id);
  return c.json({ items: projects.map((p) => presentProject(p, defaultId)) });
}

export async function getProject(c: Context) {
  const project = projectOf(c);
  return c.json(presentProject(project, await defaultProjectOf(project.tenant_id)));
}
