import { listProjects } from '../tenancy/projects.js';

/** Project ID → slug, for labelling rows of workspace-wide queries. */
export type ProjectNames = Map<string, string>;

export async function projectNames(tenantId: string): Promise<ProjectNames> {
  return new Map((await listProjects(tenantId)).map((p) => [p.id, p.slug]));
}

export const projectFields = (projectId: string, names?: ProjectNames) => ({
  project_id: projectId,
  project: names?.get(projectId) ?? null,
});
