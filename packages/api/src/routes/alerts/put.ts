import type { Context } from 'hono';
import { jsonBody } from '../../lib/aws/requests.js';
import { parseSettings } from '../../lib/alerts/present.js';
import { alertStore } from '../../lib/alerts/store.js';
import { projectOf, requireOwner, tenantOf } from '../../lib/tenancy/context.js';

/** Owners change a project's alert settings: `{ slack_enabled?, interval_minutes?, every_occurrences?, include_throttles? }`. */
export async function putAlerts(c: Context) {
  requireOwner(c);
  const tenant = tenantOf(c).id;
  const project = projectOf(c).id;
  const settings = parseSettings(await jsonBody(c), await alertStore().getSettings(tenant, project));
  await alertStore().saveSettings(tenant, project, settings);
  return c.json(settings);
}
