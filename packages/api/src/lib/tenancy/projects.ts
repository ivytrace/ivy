import { HTTPException } from 'hono/http-exception';
import { newProjectId, workspaceDefaultProject } from './ids.js';
import { claimSlug, isSlug, RESERVED_PROJECT_SLUGS, slugify } from './slugs.js';
import { tenancyStore, type ProjectRecord } from './store.js';

const TTL_MS = 10_000;
const cache = new Map<string, { projects: Promise<ProjectRecord[]>; expires: number }>();

/** A workspace's projects (archived ones included), cached briefly; writes in this process refresh it. */
export function listProjects(tenantId: string): Promise<ProjectRecord[]> {
  const hit = cache.get(tenantId);
  if (hit && hit.expires > Date.now()) return hit.projects;
  const projects = tenancyStore().listProjects(tenantId);
  cache.set(tenantId, { projects, expires: Date.now() + TTL_MS });
  projects.catch(() => cache.delete(tenantId));
  return projects;
}

export function forgetProjects(tenantId?: string) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

/** A project by ID (`prj_…`) or slug. */
export async function findProject(tenantId: string, ref: string): Promise<ProjectRecord | null> {
  if (!ref) return null;
  const projects = await listProjects(tenantId);
  return projects.find((p) => p.id === ref) ?? projects.find((p) => p.slug === ref) ?? null;
}

/** The workspace's current default project ID, read from the control database (not cached). */
export async function defaultProjectOf(tenantId: string): Promise<string> {
  return workspaceDefaultProject((await tenancyStore().getTenant(tenantId)) ?? { id: tenantId });
}

const bad = (message: string) => new HTTPException(400, { message });

function checkName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw bad('name must be a non-empty string');
  return name.trim().slice(0, 100);
}

function checkSlug(slug: unknown, projects: ProjectRecord[], self?: string): string {
  if (typeof slug !== 'string' || !isSlug(slug)) {
    throw bad('slug must be 1–40 lower-case letters, digits and dashes, starting and ending with a letter or digit');
  }
  if (RESERVED_PROJECT_SLUGS.includes(slug)) throw bad(`"${slug}" is reserved`);
  if (projects.some((p) => p.slug === slug && p.id !== self)) {
    throw new HTTPException(409, { message: `A project with slug "${slug}" already exists in this workspace` });
  }
  return slug;
}

async function save(project: ProjectRecord) {
  await tenancyStore().saveProject(project);
  forgetProjects(project.tenant_id);
}

export async function createProject(tenantId: string, input: { name?: unknown; slug?: unknown }): Promise<ProjectRecord> {
  const name = checkName(input.name);
  const store = tenancyStore();
  const project: ProjectRecord = { tenant_id: tenantId, id: newProjectId(), slug: '', name, archived: false, created_at: Date.now() };
  if (input.slug !== undefined && input.slug !== '') {
    project.slug = checkSlug(input.slug, await store.listProjects(tenantId));
    await save(project);
    return project;
  }
  // Unique within the workspace: the oldest project holding a slug keeps it (see claimSlug).
  const holders = async (slug: string) => (await store.listProjects(tenantId)).filter((p) => p.slug === slug);
  project.slug = await claimSlug({
    scope: `project:${tenantId}`,
    base: slugify(name, 'project'),
    taken: async (slug) => RESERVED_PROJECT_SLUGS.includes(slug) || (await holders(slug)).some((p) => p.id !== project.id),
    write: (slug) => store.saveProject({ ...project, slug }),
    won: async (slug) => (await holders(slug))[0]?.id === project.id,
  });
  forgetProjects(tenantId);
  return project;
}

/** An active project of the workspace other than `except`, by ID or slug; 400 otherwise. */
function activeProject(projects: ProjectRecord[], ref: unknown, field: string, except?: string): ProjectRecord {
  if (typeof ref !== 'string' || !ref) throw bad(`${field} must be a project ID or slug`);
  const project = projects.find((p) => p.id === ref) ?? projects.find((p) => p.slug === ref);
  if (!project || project.id === except) throw bad(`${field}: unknown project ${ref}`);
  if (project.archived) throw bad(`${field}: project ${project.slug} is archived`);
  return project;
}

/** Makes an active project (ID or slug) the workspace's default. */
export async function setDefaultProject(tenantId: string, ref: unknown): Promise<ProjectRecord> {
  const store = tenancyStore();
  const project = activeProject(await store.listProjects(tenantId), ref, 'default_project');
  const tenant = await store.getTenant(tenantId);
  if (!tenant) throw new HTTPException(404, { message: 'Workspace not found' });
  if (workspaceDefaultProject(tenant) !== project.id) await store.saveTenant({ ...tenant, default_project_id: project.id });
  return project;
}

/**
 * Before archiving: a workspace keeps at least one active project, and archiving the default project
 * first moves the designation to `newDefault` (ID or slug) or, without it, the oldest remaining active
 * project. The tenant row is written before the project row, so a failure in between leaves the old
 * default active rather than a default that is archived.
 */
async function prepareArchive(project: ProjectRecord, newDefault: unknown): Promise<void> {
  const store = tenancyStore();
  const projects = await store.listProjects(project.tenant_id);
  const others = projects.filter((p) => !p.archived && p.id !== project.id);
  if (!others.length) throw new HTTPException(409, { message: 'A workspace needs at least one project' });
  const next = newDefault === undefined || newDefault === null || newDefault === '' ? others[0] : activeProject(projects, newDefault, 'new_default', project.id);
  const tenant = await store.getTenant(project.tenant_id);
  if (tenant && workspaceDefaultProject(tenant) === project.id) await store.saveTenant({ ...tenant, default_project_id: next.id });
}

/**
 * Renames, re-slugs, archives or unarchives a project. Archiving the default project moves the
 * default (see prepareArchive); the last active project can't be archived.
 */
export async function updateProject(
  project: ProjectRecord,
  input: { name?: unknown; slug?: unknown; archived?: unknown; new_default?: unknown },
): Promise<ProjectRecord> {
  const next = { ...project };
  if (input.name !== undefined) next.name = checkName(input.name);
  if (input.slug !== undefined && input.slug !== project.slug) {
    next.slug = checkSlug(input.slug, await tenancyStore().listProjects(project.tenant_id), project.id);
  }
  if (input.archived !== undefined) {
    if (typeof input.archived !== 'boolean') throw bad('archived must be a boolean');
    if (input.archived && !project.archived) await prepareArchive(project, input.new_default);
    next.archived = input.archived;
  }
  await save(next);
  return next;
}

export const presentProject = (p: ProjectRecord, defaultId: string) => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  archived: Boolean(p.archived),
  default: p.id === defaultId,
  created_at: new Date(p.created_at).toISOString(),
});
