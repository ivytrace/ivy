import type { Context } from 'hono';
import { jsonBody } from '../../lib/aws/requests.js';
import { parseFullSettings } from '../../lib/alerts/present.js';
import { alertStore } from '../../lib/alerts/store.js';
import { requireOwner, tenantOf } from '../../lib/tenancy/context.js';
import { listProjects } from '../../lib/tenancy/projects.js';
import { badRequest } from '../../lib/utils/http-error.js';

const MAX_PROJECTS = 500;

/**
 * Owners apply one alert rule to several projects: `{ projects: [id…], settings: {…all four} }`. Every project
 * must be an active project of this workspace, or nothing is written. Slack channels are not copied.
 */
export async function postAlertsApply(c: Context) {
  requireOwner(c);
  const tenant = tenantOf(c).id;
  const body = await jsonBody(c);
  const ids = body.projects;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_PROJECTS || ids.some((id) => typeof id !== 'string' || !id)) {
    throw badRequest(`projects must be an array of 1–${MAX_PROJECTS} project IDs`);
  }
  const settings = parseFullSettings(body.settings);
  const active = new Map((await listProjects(tenant)).filter((p) => !p.archived).map((p) => [p.id, p]));
  const unknown = ids.filter((id) => !active.has(id));
  if (unknown.length) throw badRequest(`Not an active project of this workspace: ${unknown.join(', ')}`);
  const projects = [...new Set(ids as string[])].map((id) => active.get(id)!);
  await alertStore().saveSettingsForProjects(
    tenant,
    projects.map((p) => p.id),
    settings,
  );
  return c.json({ updated: projects.length, projects: projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name })), settings });
}
