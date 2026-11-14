import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { timeseries } from '../../lib/data/timeseries.js';
import { dataScopeOf, type DataScope } from '../../lib/tenancy/context.js';
import { findProject } from '../../lib/tenancy/projects.js';
import { parseTimeRange } from '../../lib/utils/time-range.js';

/**
 * Project-scoped, or workspace-wide (all projects). Workspace-wide, `project` narrows to one project
 * of the workspace, for a function whose name exists in several projects.
 */
export async function getTimeseries(c: Context) {
  const params = c.req.query();
  let scope: DataScope = dataScopeOf(c);
  if (scope.projectId === null && params.project) {
    const project = await findProject(scope.tenant.id, params.project);
    if (!project) throw new HTTPException(404, { message: 'Project not found' });
    scope = { tenant: scope.tenant, projectId: project.id };
  }
  const items = await timeseries(scope, parseTimeRange(params), { function: params.function, bucket: params.bucket });
  return c.json({ items });
}
