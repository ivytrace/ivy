import type { Context } from 'hono';
import { errorGroups } from '../../lib/data/errors.js';
import { projectNames } from '../../lib/data/projects.js';
import { dataScopeOf } from '../../lib/tenancy/context.js';
import { parseTimeRange } from '../../lib/utils/time-range.js';

/** Project-scoped, or workspace-wide (all projects; items then carry `project_id` and `project`). */
export async function getErrors(c: Context) {
  const params = c.req.query();
  const scope = dataScopeOf(c);
  const names = scope.projectId === null ? await projectNames(scope.tenant.id) : undefined;
  return c.json({ items: await errorGroups(scope, parseTimeRange(params), params.function || undefined, names) });
}
