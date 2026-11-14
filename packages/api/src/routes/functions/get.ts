import type { Context } from 'hono';
import { functionSummaries } from '../../lib/data/functions.js';
import { projectNames } from '../../lib/data/projects.js';
import { dataScopeOf } from '../../lib/tenancy/context.js';
import { parseTimeRange } from '../../lib/utils/time-range.js';

/** Project-scoped, or workspace-wide (all projects; items then carry `project_id` and `project`). */
export async function getFunctions(c: Context) {
  const scope = dataScopeOf(c);
  const names = scope.projectId === null ? await projectNames(scope.tenant.id) : undefined;
  return c.json({ items: await functionSummaries(scope, parseTimeRange(c.req.query()), names) });
}
