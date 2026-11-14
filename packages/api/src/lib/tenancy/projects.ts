import { HTTPException } from 'hono/http-exception';
import { defaultProjectId, newProjectId } from './ids.js';
import { isSlug, RESERVED_PROJECT_SLUGS, slugify, uniqueSlug } from './slugs.js';
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

export const isDefaultProject = (p: Pick<ProjectRecord, 'tenant_id' | 'id'>) => p.id === defaultProjectId(p.tenant_id);

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
  const projects = await tenancyStore().listProjects(tenantId);
  const slug =
    input.slug === undefined || input.slug === ''
      ? await uniqueSlug(slugify(name, 'project'), (s) => RESERVED_PROJECT_SLUGS.includes(s) || projects.some((p) => p.slug === s))
      : checkSlug(input.slug, projects);
  const project: ProjectRecord = { tenant_id: tenantId, id: newProjectId(), slug, name, archived: false, created_at: Date.now() };
  await save(project);
  return project;
}

/** Renames, re-slugs, archives or unarchives a project. The default project can't be archived. */
export async function updateProject(
  project: ProjectRecord,
  input: { name?: unknown; slug?: unknown; archived?: unknown },
): Promise<ProjectRecord> {
  const next = { ...project };
  if (input.name !== undefined) next.name = checkName(input.name);
  if (input.slug !== undefined && input.slug !== project.slug) {
    next.slug = checkSlug(input.slug, await tenancyStore().listProjects(project.tenant_id), project.id);
  }
  if (input.archived !== undefined) {
    if (typeof input.archived !== 'boolean') throw bad('archived must be a boolean');
    if (input.archived && isDefaultProject(project)) {
      throw new HTTPException(409, { message: "The workspace's default project can't be archived" });
    }
    next.archived = input.archived;
  }
  await save(next);
  return next;
}

export const presentProject = (p: ProjectRecord) => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  archived: p.archived,
  default: isDefaultProject(p),
  created_at: new Date(p.created_at).toISOString(),
});
