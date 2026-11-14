import type { Context } from 'hono';
import { projectOf, tenantOf } from '../../lib/tenancy/context.js';
import { listProjects, presentProject } from '../../lib/tenancy/projects.js';

/** The workspace's projects; `?archived=1` includes archived ones. */
export async function getProjects(c: Context) {
  const archived = c.req.query('archived') === '1';
  const projects = (await listProjects(tenantOf(c).id)).filter((p) => archived || !p.archived);
  return c.json({ items: projects.map(presentProject) });
}

export const getProject = (c: Context) => c.json(presentProject(projectOf(c)));
