import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { shardClient } from '../clickhouse/client.js';
import { scopedQuery, type QueryScope } from '../clickhouse/scoped.js';
import { findProject } from './projects.js';
import { tenancyStore, type MemberRole, type ProjectRecord, type TenantRecord } from './store.js';

/** The tenant (workspace) a request acts for, and the shard (cell) holding its span data. */
export interface Tenant {
  id: string;
  shardId: string;
}

/** A workspace the caller can use, with their role in it. */
export interface Membership {
  workspace: TenantRecord;
  role: MemberRole;
}

/**
 * Who may use which workspace (the app uses `userWorkspaceAccess` from members.ts). `find` returns
 * null for a workspace that doesn't exist or that the caller isn't a member of: both answer 404.
 */
export interface WorkspaceAccess {
  list(c: Context): Promise<Membership[]>;
  find(c: Context, ref: string): Promise<Membership | null>;
}

const TTL_MS = 30_000;
const shardCache = new Map<string, { tenant: Tenant | null; expires: number }>();

/** Tenant directory lookup (tenant → shard), cached briefly so moving a tenant takes effect within TTL_MS. */
export async function lookupTenant(id: string): Promise<Tenant | null> {
  const hit = shardCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.tenant;
  const record = await tenancyStore().getTenant(id);
  const tenant = record ? { id: record.id, shardId: record.shard_id } : null;
  shardCache.set(id, { tenant, expires: Date.now() + TTL_MS });
  return tenant;
}

export function clearTenantCacheForTests() {
  shardCache.clear();
}

declare module 'hono' {
  interface ContextVariableMap {
    tenant: Tenant;
    membership: Membership;
    project: ProjectRecord;
    allProjects: boolean;
  }
}

/**
 * For `/api/w/:workspace/*`: resolves the workspace (slug or ID) and checks the caller is a member.
 * Non-members get the same 404 as a workspace that doesn't exist.
 */
export function workspaceContext(access: WorkspaceAccess): MiddlewareHandler {
  return async (c, next) => {
    const ref = c.req.param('workspace') ?? '';
    const membership = ref ? await access.find(c, ref) : null;
    const tenant = membership && (await lookupTenant(membership.workspace.id));
    if (!membership || !tenant) throw new HTTPException(404, { message: 'Workspace not found' });
    c.set('membership', membership);
    c.set('tenant', tenant);
    await next();
  };
}

/** For `/api/w/:workspace/p/:project/*`: the project (slug or ID) within the request's workspace. */
export function projectContext(): MiddlewareHandler {
  return async (c, next) => {
    const project = await findProject(tenantOf(c).id, c.req.param('project') ?? '');
    if (!project) throw new HTTPException(404, { message: 'Project not found' });
    c.set('project', project);
    await next();
  };
}

/** Marks a workspace-level data route as reading every project of the workspace, explicitly. */
export const allProjects = (): MiddlewareHandler => async (c, next) => {
  c.set('allProjects', true);
  await next();
};

export function tenantOf(c: Context): Tenant {
  const tenant = c.get('tenant');
  if (!tenant) throw new Error('No tenant context: route is not behind workspaceContext()');
  return tenant;
}

export function membershipOf(c: Context): Membership {
  const membership = c.get('membership');
  if (!membership) throw new Error('No workspace context: route is not behind workspaceContext()');
  return membership;
}

export function projectOf(c: Context): ProjectRecord {
  const project = c.get('project');
  if (!project) throw new Error('No project context: route is not behind projectContext()');
  return project;
}

/** 403 unless the caller owns the workspace. */
export function requireOwner(c: Context) {
  if (membershipOf(c).role !== 'owner') throw new HTTPException(403, { message: 'Only workspace owners can do this' });
}

/**
 * Where a data query reads: one tenant on its shard, and either one project or (explicitly) all
 * projects of the workspace. Usable without a request (e.g. by the MCP server) through
 * `scopeFor`/`queryData` in lib/data.
 */
export interface DataScope {
  tenant: Tenant;
  /** A project ID, or null for every project of the workspace. */
  projectId: string | null;
}

export const queryScope = (scope: DataScope): QueryScope =>
  scope.projectId === null ? { tenant: scope.tenant.id, allProjects: true } : { tenant: scope.tenant.id, project: scope.projectId };

/** Query against a scope's shard; binds `{tenant:String}` and `{project:String}` (see clickhouse/scoped.ts). */
export function scopedDataQuery<T>(scope: DataScope, sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
  return scopedQuery<T>(shardClient(scope.tenant.shardId), queryScope(scope), sql, params);
}

/** The request's data scope: its project, or all projects on routes mounted with `allProjects()`. */
export function dataScopeOf(c: Context): DataScope {
  const tenant = tenantOf(c);
  const project = c.get('project');
  if (project) return { tenant, projectId: project.id };
  if (c.get('allProjects')) return { tenant, projectId: null };
  throw new Error('Data route without a project or an explicit allProjects()');
}
