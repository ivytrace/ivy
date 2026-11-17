import type { IvyData } from '@ivy/mcp';
import type { ErrorGroup, Invocation, Trace } from '@ivy/spans';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { runWorkspaceQuery } from '../clickhouse/workspace-query.js';
import { errorGroups } from '../data/errors.js';
import { listInvocations } from '../data/invocations.js';
import { projectNames } from '../data/projects.js';
import { getTrace } from '../data/traces.js';
import type { DataScope } from '../tenancy/context.js';
import { findProject } from '../tenancy/projects.js';
import { parseTimeRange } from '../utils/time-range.js';
import type { ApiWorkspace, WorkspaceSource } from './workspaces.js';

/**
 * Where a read goes: one project of the workspace (slug or ID), or all of its projects. null when the
 * workspace has no such project (the read then returns nothing for this workspace).
 */
async function scopeOf(w: ApiWorkspace, project: string | undefined): Promise<DataScope | null> {
  if (!project) return { tenant: w.tenant, projectId: null };
  const match = await findProject(w.tenant.id, project);
  return match ? { tenant: w.tenant, projectId: match.id } : null;
}

/** Project slugs for labelling rows of a workspace-wide read (as the API's workspace-wide routes do). */
const namesFor = (scope: DataScope) => (scope.projectId === null ? projectNames(scope.tenant.id) : Promise.resolve(undefined));

const range = (q: { since?: string; from?: string; to?: string }) =>
  parseTimeRange(Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)) as Record<string, string>);

/** Validation errors (HTTP 400) become plain errors with the API's message. */
async function api<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HTTPException) throw new Error(err.message);
    throw err;
  }
}

/**
 * The MCP tools' reads, through the same query functions (lib/data) and guards as the API: one
 * tenant-scoped (and, with `project`, project-scoped) read per workspace. The fan-out over workspaces
 * is in @ivy/mcp.
 */
export function apiData(c: Context, workspaces: WorkspaceSource): IvyData<ApiWorkspace> {
  let resolved: Promise<ApiWorkspace[]> | undefined;
  return {
    workspaces: () => (resolved ??= workspaces(c)),
    invocations: (w, query) =>
      api(async () => {
        const scope = await scopeOf(w, query.project);
        if (!scope) return [];
        const filters = { function: query.function, status: query.status, q: query.q, limit: query.limit };
        const { items } = await listInvocations(scope, range(query), filters, await namesFor(scope));
        return items as Invocation[];
      }),
    trace: (w, traceId, project) =>
      api(async () => {
        const scope = await scopeOf(w, project);
        return scope ? ((await getTrace(scope, traceId)) as Trace | null) : null;
      }),
    errors: (w, query) =>
      api(async () => {
        const scope = await scopeOf(w, query.project);
        return scope ? ((await errorGroups(scope, range(query), query.function, await namesFor(scope))) as ErrorGroup[]) : [];
      }),
    query: (w, query) =>
      api(async () => {
        const scope = await scopeOf(w, query.project);
        if (!scope) throw new Error(`Workspace ${w.slug} has no project ${query.project}`);
        const { sql, limit = 100 } = query;
        return runWorkspaceQuery({ tenant: scope.tenant, projectId: scope.projectId, range: range(query), sql, maxRows: limit });
      }),
  };
}
