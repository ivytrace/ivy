import type { Context } from 'hono';
import { presentIntegration, slackAvailability } from '../../lib/alerts/present.js';
import { alertStore } from '../../lib/alerts/store.js';
import { membershipOf, projectOf, tenantOf } from '../../lib/tenancy/context.js';

/** The project's alert settings and Slack channels, and whether Slack is configured on this server. */
export async function getAlerts(c: Context) {
  const tenant = tenantOf(c).id;
  const project = projectOf(c).id;
  const [settings, integrations] = await Promise.all([alertStore().getSettings(tenant, project), alertStore().listIntegrations(tenant, project)]);
  return c.json({
    available: slackAvailability(),
    can_edit: membershipOf(c).role === 'owner',
    settings,
    integrations: integrations.map(presentIntegration),
  });
}
