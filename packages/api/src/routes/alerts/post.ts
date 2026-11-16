import type { Context } from 'hono';
import { authUser } from '../../lib/auth/user.js';
import { slackConfig } from '../../lib/alerts/config.js';
import { parseFullSettings } from '../../lib/alerts/present.js';
import { alertStore, type SlackIntegration } from '../../lib/alerts/store.js';
import { jsonBody } from '../../lib/aws/requests.js';
import { requireOwner, tenantOf } from '../../lib/tenancy/context.js';
import { randomBase62 } from '../../lib/tenancy/ids.js';
import { listProjects } from '../../lib/tenancy/projects.js';
import { decrypt } from '../../lib/tenancy/secret-box.js';
import { badRequest } from '../../lib/utils/http-error.js';

const MAX_PROJECTS = 500;

/**
 * Owners copy a project's alerts to several projects: `{ source, projects: [id…], settings: {…all four} }` sets the
 * rule and adds the source's working Slack channels. Every project must be an active project of this workspace, or
 * nothing is written (docs/implementation/alerts.md).
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
  if (typeof body.source !== 'string' || !active.has(body.source)) throw badRequest('source must be an active project of this workspace');
  const projects = [...new Set(ids as string[])].map((id) => active.get(id)!);
  const added = await channelCopies(tenant, body.source, projects.map((p) => p.id), authUser(c)?.sub ?? '');

  const store = alertStore();
  // Two inserts (ClickHouse has no transactions): the channels first, removed again if the settings fail.
  await store.saveIntegrations(added);
  try {
    await store.saveSettingsForProjects(
      tenant,
      projects.map((p) => p.id),
      settings,
    );
  } catch (err) {
    await store.saveIntegrations(added, true).catch(() => {});
    throw err;
  }
  return c.json({
    updated: projects.length,
    projects: projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name, channels_added: added.filter((i) => i.project_id === p.id).length })),
    settings,
    channels_added: added.length,
  });
}

/**
 * New rows for the source's working channels in each target, connected now (so the targets' existing error groups
 * get a baseline, not a "New error" message). A target that already has the webhook, or the same Slack channel, is skipped.
 */
async function channelCopies(tenant: string, source: string, targets: string[], sub: string): Promise<SlackIntegration[]> {
  const secret = slackConfig()?.secret;
  const webhook = (i: SlackIntegration) => {
    if (!secret) return i.encrypted_webhook_url;
    try {
      return decrypt(i.encrypted_webhook_url, secret);
    } catch {
      return i.encrypted_webhook_url;
    }
  };
  const all = await alertStore().listWorkspaceIntegrations(tenant);
  const channels = all.filter((i) => i.project_id === source && i.status === 'ok');
  const now = Date.now();
  const out: SlackIntegration[] = [];
  for (const project of targets) {
    if (project === source) continue;
    const existing = all.filter((i) => i.project_id === project);
    for (const ch of channels) {
      const known = existing.some((i) => webhook(i) === webhook(ch) || (i.team_id === ch.team_id && i.channel_id && i.channel_id === ch.channel_id));
      if (known) continue;
      out.push({ ...ch, project_id: project, id: `slk_${randomBase62(21)}`, created_by: sub, created_at: now });
    }
  }
  return out;
}
