import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { authUser } from '../../lib/auth/user.js';
import { slackAuthorizeUrl, slackConfig, type SlackConfig } from '../../lib/alerts/config.js';
import { deliver } from '../../lib/alerts/evaluate.js';
import { simplePage } from '../../lib/alerts/page.js';
import { presentIntegration, requireSlack } from '../../lib/alerts/present.js';
import { sign, verify } from '../../lib/alerts/signing.js';
import { exchangeCode, formatTestMessage, postWebhook, SlackOAuthError } from '../../lib/alerts/slack.js';
import { alertStore } from '../../lib/alerts/store.js';
import { membershipOf, projectOf, requireOwner, tenantOf } from '../../lib/tenancy/context.js';
import { randomBase62 } from '../../lib/tenancy/ids.js';
import { multiWorkspaceMode } from '../../lib/tenancy/members.js';
import { listProjects } from '../../lib/tenancy/projects.js';
import { encrypt } from '../../lib/tenancy/secret-box.js';
import { tenancyStore } from '../../lib/tenancy/store.js';

/** Slack's OAuth v2 flow with only the `incoming-webhook` scope (docs/implementation/alerts.md). */

const STATE_TTL_MS = 10 * 60_000;
const COOKIE = 'ivy_slack_oauth';
const PURPOSE = 'slack-oauth-state';

export const redirectUri = (config: SlackConfig) => `${config.publicUrl}/api/slack/oauth/callback`;

interface State {
  w: string;
  p: string;
  u: string;
  n: string;
  exp: number;
  [key: string]: unknown;
}

/**
 * Starts "Add to Slack" (owners): returns Slack's authorize URL with a signed, short-lived state
 * naming the workspace, project and user, and sets a cookie with the state's nonce so the callback
 * only completes in the browser that started it.
 */
export async function postSlackConnect(c: Context) {
  requireOwner(c);
  requireSlack();
  const config = slackConfig()!;
  const nonce = randomBase62(22);
  const state = sign(
    { w: tenantOf(c).id, p: projectOf(c).id, u: authUser(c)?.sub ?? '', n: nonce, exp: Date.now() + STATE_TTL_MS } satisfies State,
    config.secret,
    PURPOSE,
  );
  setCookie(c, COOKIE, nonce, {
    path: '/api/slack',
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.publicUrl.startsWith('https://'),
    maxAge: STATE_TTL_MS / 1000,
  });
  const url = new URL(slackAuthorizeUrl());
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', 'incoming-webhook');
  url.searchParams.set('redirect_uri', redirectUri(config));
  url.searchParams.set('state', state);
  return c.json({ url: url.toString() });
}

function failPage(c: Context, status: 400 | 409, title: string, body: string) {
  return c.html(simplePage(title, body, '<p><a href="/">Back to Ivy</a></p>'), status);
}

/** Slack redirects here after the user picked a channel (or cancelled). */
export async function getSlackCallback(c: Context) {
  const config = slackConfig();
  if (!config) return failPage(c, 409, 'Slack is not configured', 'This Ivy server has no Slack app configured.');
  const state = verify<State>(c.req.query('state') ?? '', config.secret, PURPOSE);
  if (!state || typeof state.w !== 'string' || typeof state.p !== 'string') {
    return failPage(c, 400, 'This Slack link has expired', 'Start again from the project’s alert settings in Ivy (the link is valid for 10 minutes).');
  }
  if (getCookie(c, COOKIE) !== state.n) {
    return failPage(c, 400, 'Start from Ivy', 'This Slack authorization was started in another browser or has already been used. Start again from the project’s alert settings.');
  }
  deleteCookie(c, COOKIE, { path: '/api/slack' });

  const tenant = await tenancyStore().getTenant(state.w);
  const project = tenant && (await listProjects(tenant.id)).find((p) => p.id === state.p);
  if (!tenant || !project) return failPage(c, 400, 'Project not found', 'The project this Slack channel was meant for no longer exists.');
  const back = (result: string, message?: string) => {
    const url = new URL(`${config.publicUrl}/w/${encodeURIComponent(tenant.slug)}/settings/alerts/${encodeURIComponent(project.slug)}`);
    url.searchParams.set('slack', result);
    if (message) url.searchParams.set('message', message);
    return c.redirect(url.toString(), 302);
  };

  if (multiWorkspaceMode()) {
    const member = (await tenancyStore().listMembers(tenant.id)).find((m) => m.sub === state.u);
    if (member?.role !== 'owner') return back('error', 'Only workspace owners can connect Slack');
  }
  const error = c.req.query('error');
  if (error) return back(error === 'access_denied' ? 'denied' : 'error', error === 'access_denied' ? undefined : `Slack: ${error}`);
  const code = c.req.query('code');
  if (!code) return back('error', 'Slack sent no authorization code');

  try {
    const result = await exchangeCode(config, code, redirectUri(config));
    const store = alertStore();
    const existing = (await store.listIntegrations(tenant.id, project.id)).find((i) => i.team_id === result.team_id && i.channel_id === result.channel_id && result.channel_id);
    await store.saveIntegration({
      tenant_id: tenant.id,
      project_id: project.id,
      id: existing?.id ?? `slk_${randomBase62(21)}`,
      team_id: result.team_id,
      team_name: result.team_name,
      channel: result.channel,
      channel_id: result.channel_id,
      encrypted_webhook_url: encrypt(result.webhook_url, config.secret),
      configuration_url: result.configuration_url,
      status: 'ok',
      error: '',
      created_by: state.u,
      created_at: existing?.created_at ?? Date.now(),
    });
    return back('connected');
  } catch (err) {
    if (!(err instanceof SlackOAuthError)) console.error('[slack] oauth callback', err);
    return back('error', err instanceof SlackOAuthError ? err.message : 'Connecting Slack failed');
  }
}

async function loadIntegration(c: Context) {
  const integration = (await alertStore().listIntegrations(tenantOf(c).id, projectOf(c).id)).find((i) => i.id === c.req.param('id'));
  if (!integration) throw new HTTPException(404, { message: 'Slack channel not found' });
  return integration;
}

/** Removes a channel from the project (owners). The webhook stays in Slack until removed there. */
export async function deleteSlackIntegration(c: Context) {
  requireOwner(c);
  const integration = await loadIntegration(c);
  await alertStore().deleteIntegration(integration);
  return c.json({ removed: true });
}

/** Posts a test message to one channel (owners); a webhook Slack rejects as gone is marked broken. */
export async function postSlackTest(c: Context) {
  requireOwner(c);
  requireSlack();
  const integration = await loadIntegration(c);
  const workspace = membershipOf(c).workspace;
  const project = projectOf(c);
  const config = slackConfig()!;
  const message = formatTestMessage({
    workspace: { slug: workspace.slug, name: workspace.name },
    project: { slug: project.slug, name: project.name },
    baseUrl: config.publicUrl,
  });
  const wasBroken = integration.status !== 'ok';
  const delivery = await deliver(integration, message, config.secret, (url, m) => postWebhook(url, m));
  // A successful test revives a channel marked broken (e.g. after it was unarchived).
  if (delivery.ok && wasBroken) {
    integration.status = 'ok';
    integration.error = '';
    await alertStore().saveIntegration(integration);
  }
  return c.json({ ok: delivery.ok, error: delivery.ok ? null : delivery.error, integration: presentIntegration(integration) });
}
