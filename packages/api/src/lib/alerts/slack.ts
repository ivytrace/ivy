import { FAILURE_LABELS } from '@ivy/spans';
import { slackApiUrl, type SlackConfig } from './config.js';
import { groupMessage, type AlertGroup } from './data.js';

/** Slack: the OAuth code exchange, Block Kit messages and webhook delivery (docs/implementation/alerts.md). */

export interface OAuthResult {
  team_id: string;
  team_name: string;
  channel: string;
  channel_id: string;
  webhook_url: string;
  configuration_url: string;
}

export class SlackOAuthError extends Error {}

/** `oauth.v2.access`: trades the code for the incoming webhook Slack created for the chosen channel. */
export async function exchangeCode(config: SlackConfig, code: string, redirectUri: string, fetchImpl: typeof fetch = fetch): Promise<OAuthResult> {
  const res = await fetchImpl(`${slackApiUrl()}/oauth.v2.access`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err: Error) => {
    throw new SlackOAuthError(`Slack could not be reached (${err.message})`);
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    team?: { id?: string; name?: string };
    incoming_webhook?: { channel?: string; channel_id?: string; url?: string; configuration_url?: string };
  } | null;
  if (!res.ok || !body?.ok) throw new SlackOAuthError(`Slack refused the authorization (${body?.error ?? `HTTP ${res.status}`})`);
  const hook = body.incoming_webhook;
  if (!hook?.url || !/^https?:\/\//.test(hook.url)) throw new SlackOAuthError('Slack returned no incoming webhook (was the incoming-webhook scope granted?)');
  return {
    team_id: body.team?.id ?? '',
    team_name: body.team?.name ?? '',
    channel: hook.channel ?? '',
    channel_id: hook.channel_id ?? '',
    webhook_url: hook.url,
    configuration_url: hook.configuration_url ?? '',
  };
}

export interface MessageContext {
  workspace: { slug: string; name: string };
  project: { slug: string; name: string };
  /** IVY_PUBLIC_URL. */
  baseUrl: string;
  /** Minutes covered by "N more" (the time since the last message). */
  sinceMinutes: number | null;
  /** The first stack frame of the latest occurrence. */
  stack?: string | null;
}

const trim = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Slack mrkdwn escaping: only &, < and > are special. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

const enc = encodeURIComponent;

/** Where "View in Ivy" goes: the latest trace, or the project's errors page filtered to the function. */
export function groupLink(ctx: Pick<MessageContext, 'workspace' | 'project' | 'baseUrl'>, group: Pick<AlertGroup, 'sample_trace_id' | 'function'>) {
  const base = `${ctx.baseUrl}/w/${enc(ctx.workspace.slug)}/${enc(ctx.project.slug)}`;
  return group.sample_trace_id ? `${base}/traces/${enc(group.sample_trace_id)}` : `${base}/errors?function=${enc(group.function)}`;
}

/** "First seen" or "37 more in the last 60 min · 412 total". */
export function countLine(group: AlertGroup, firstTime: boolean, sinceMinutes: number | null) {
  if (firstTime && group.total === group.since_notify && group.total <= 1) return 'First seen';
  if (firstTime) return `First seen · ${plural(group.total, 'occurrence')} so far`;
  const window = sinceMinutes === null ? '' : ` in the last ${sinceMinutes >= 120 ? `${Math.round(sinceMinutes / 60)} h` : `${sinceMinutes} min`}`;
  return `${group.since_notify.toLocaleString('en-US')} more${window} · ${group.total.toLocaleString('en-US')} total`;
}

/**
 * The Block Kit message for one error group. Never carries payloads or log lines (they may hold
 * personal data): type, the error message (trimmed), function, project, workspace, counts, a link.
 */
export function formatGroupMessage(group: AlertGroup, ctx: MessageContext, firstTime: boolean) {
  const title = group.kind === 'throttle' ? 'Throttled' : group.failure_kind ? `${FAILURE_LABELS[group.failure_kind]}: ${group.error_type}` : group.error_type;
  const message = trim(groupMessage(group), 280);
  const counts = `${countLine(group, firstTime, ctx.sinceMinutes)}${group.variants > 1 ? ` · ${plural(group.variants, 'variant')}` : ''}`;
  const heading = `${firstTime ? ':red_circle: New error' : ':repeat: Error'} in ${ctx.project.name}`;
  const text = `${firstTime ? 'New error' : 'Error'} in ${ctx.project.name}: ${trim(title, 80)}${message ? ` · ${trim(groupMessage(group), 120)}` : ''} (${counts})`;
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${esc(heading)}*\n*${esc(trim(title, 150))}*${message ? `\n${esc(message)}` : ''}` } },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `\`${esc(trim(group.function, 120))}\`` },
          { type: 'mrkdwn', text: `${esc(ctx.project.name)} · ${esc(ctx.workspace.name)}` },
          { type: 'mrkdwn', text: esc(counts) },
        ],
      },
      ...(ctx.stack ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `\`${esc(trim(ctx.stack, 200))}\`` }] }] : []),
      {
        type: 'actions',
        elements: [{ type: 'button', text: { type: 'plain_text', text: 'View in Ivy' }, url: groupLink(ctx, group), action_id: 'view_in_ivy' }],
      },
    ],
  };
}

export function formatTestMessage(ctx: Pick<MessageContext, 'workspace' | 'project' | 'baseUrl'>) {
  const text = `Test message from Ivy: alerts for ${ctx.project.name} (${ctx.workspace.name}) will be posted here.`;
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${esc(text)}*\nA message is sent when an error group is first seen, then at most as often as the project's alert settings allow.` } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open alert settings' },
            url: `${ctx.baseUrl}/w/${enc(ctx.workspace.slug)}/settings/alerts/${enc(ctx.project.slug)}`,
            action_id: 'open_settings',
          },
        ],
      },
    ],
  };
}

export type Delivery =
  | { ok: true }
  /** Slack says the webhook is gone (revoked, channel archived or deleted): stop using it. */
  | { ok: false; broken: true; error: string }
  | { ok: false; broken: false; error: string };

const DEAD = /invalid_token|no_service|channel_not_found|channel_is_archived|no_team|team_disabled|no_active_hooks|action_prohibited|no_service_id/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Posts to an incoming webhook. Retries 429 and 5xx (and network errors) a few times, honouring
 * Retry-After (capped); other 4xx are not retried, and those meaning the webhook is gone are
 * reported as broken.
 */
export async function postWebhook(
  url: string,
  message: unknown,
  options: { fetchImpl?: typeof fetch; attempts?: number; maxWaitMs?: number; baseDelayMs?: number } = {},
): Promise<Delivery> {
  const { fetchImpl = fetch, attempts = 3, maxWaitMs = 30_000, baseDelayMs = 1000 } = options;
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      lastError = (err as Error).message;
      if (attempt < attempts) await sleep(baseDelayMs * attempt);
      continue;
    }
    const body = (await res.text().catch(() => '')).trim().slice(0, 200);
    if (res.ok) return { ok: true };
    lastError = `HTTP ${res.status}${body ? ` ${body}` : ''}`;
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * attempt;
      if (attempt < attempts && wait <= maxWaitMs) {
        await sleep(wait);
        continue;
      }
      return { ok: false, broken: false, error: lastError };
    }
    const broken = [403, 404, 410].includes(res.status) || DEAD.test(body);
    return { ok: false, broken, error: lastError };
  }
  return { ok: false, broken: false, error: lastError };
}
