import { findHook, notify } from '../hooks/run.js';
import { decrypt } from '../tenancy/secret-box.js';
import { tenancyStore, type ProjectRecord, type TenantRecord } from '../tenancy/store.js';
import { publicUrl } from '../aws/config.js';
import { slackConfig } from './config.js';
import { alertData, type AlertGroup } from './data.js';
import { formatGroupMessage, groupLink, postWebhook, type Delivery } from './slack.js';
import { alertStore, type AlertSettings, type AlertState, type SlackIntegration } from './store.js';

/**
 * The alert evaluator (docs/implementation/alerts.md): once a minute, per project with Slack
 * connected (or every project when the `on-error-group-created` hook is installed), finds error
 * groups with recent occurrences and decides per group whether to announce it.
 */

/**
 * Occurrences this recent (plus the project's interval, so an occurrence soon after a message is still
 * seen when the interval is up) make a group a candidate; covers ingest lag and short restarts.
 */
export const LOOKBACK_MS = 15 * 60_000;
/** A group without alert state counts as new only if it first appeared within this long. */
const NEW_WITHIN_MS = 24 * 3600_000;
/** At most this many Slack messages per project per run; the rest wait for the next run. */
export const MAX_MESSAGES_PER_RUN = 10;

export type Decision = { send: true; first: boolean } | { send: false; baseline: boolean };

/**
 * Whether a group gets a message now:
 * - no state: a group that appeared since alerts were set up is new (message "first seen"); an older
 *   one only gets a baseline state, so connecting Slack doesn't post every existing error;
 * - otherwise: new occurrences, and either `every_occurrences` of them or `interval_minutes` since the
 *   last message.
 */
export function decide(group: AlertGroup, state: AlertState | undefined, settings: AlertSettings, now: number, newSince: number): Decision {
  if (!state) {
    return group.first_seen >= Math.max(newSince, now - NEW_WITHIN_MS) ? { send: true, first: true } : { send: false, baseline: true };
  }
  if (group.since_notify <= 0) return { send: false, baseline: false };
  if (group.since_notify >= settings.every_occurrences) return { send: true, first: false };
  if (now - state.last_notified_at >= settings.interval_minutes * 60_000) return { send: true, first: false };
  return { send: false, baseline: false };
}

export interface EvaluateOptions {
  now?: number;
  /** When the hook-only scan started (projects without Slack): groups older than this aren't "new". */
  hookSince?: number;
  /** Pause between messages to one webhook (Slack allows about one per second). */
  spacingMs?: number;
  post?: (url: string, message: unknown) => Promise<Delivery>;
}

export interface EvaluateResult {
  projects: number;
  messages: number;
  hooks: number;
}

interface Target {
  tenant: TenantRecord;
  project: ProjectRecord;
  integrations: SlackIntegration[];
}

async function targets(withHook: boolean): Promise<Target[]> {
  const store = tenancyStore();
  const byProject = new Map<string, SlackIntegration[]>();
  for (const i of await alertStore().listAllIntegrations()) {
    const key = `${i.tenant_id}/${i.project_id}`;
    byProject.set(key, [...(byProject.get(key) ?? []), i]);
  }
  const tenantIds = withHook ? (await store.listTenants()).map((t) => t.id) : [...new Set([...byProject.values()].map((l) => l[0].tenant_id))];
  const out: Target[] = [];
  for (const id of tenantIds) {
    const tenant = await store.getTenant(id);
    if (!tenant) continue;
    for (const project of await store.listProjects(id)) {
      if (project.archived) continue;
      const integrations = byProject.get(`${id}/${project.id}`) ?? [];
      if (integrations.length || withHook) out.push({ tenant, project, integrations });
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function evaluateAlerts(options: EvaluateOptions = {}): Promise<EvaluateResult> {
  const now = options.now ?? Date.now();
  const post = options.post ?? ((url, message) => postWebhook(url, message));
  const slack = slackConfig();
  const baseUrl = publicUrl() ?? '';
  const withHook = !!(await findHook('on-error-group-created'));
  const result: EvaluateResult = { projects: 0, messages: 0, hooks: 0 };
  const store = alertStore();

  for (const { tenant, project, integrations } of await targets(withHook)) {
    const settings = await store.getSettings(tenant.id, project.id);
    const channels = slack && settings.slack_enabled ? integrations.filter((i) => i.status === 'ok') : [];
    if (!channels.length && !withHook) continue;
    result.projects++;

    const scope = { tenant: { id: tenant.id, shardId: tenant.shard_id }, projectId: project.id };
    const states = new Map((await store.listStates(tenant.id, project.id)).map((s) => [s.fingerprint, s]));
    const groups = await alertData().activeGroups(scope, {
      since: now - LOOKBACK_MS - settings.interval_minutes * 60_000,
      notified: new Map([...states].map(([fp, s]) => [fp, s.last_notified_at])),
      throttles: settings.include_throttles,
    });
    // Groups are announced from when the project's first channel was connected (or the hook scan started).
    const newSince = channels.length ? Math.min(...channels.map((c) => c.created_at)) : (options.hookSince ?? now);
    const ctx = {
      workspace: { slug: tenant.slug, name: tenant.name },
      project: { slug: project.slug, name: project.name },
      baseUrl,
    };
    let sent = 0;

    for (const group of groups.sort((a, b) => b.last_seen - a.last_seen)) {
      const state = states.get(group.fingerprint);
      const decision = decide(group, state, settings, now, newSince);
      if (!decision.send) {
        if (decision.baseline) {
          await store.saveState({
            tenant_id: tenant.id,
            project_id: project.id,
            fingerprint: group.fingerprint,
            first_notified_at: now,
            last_notified_at: now,
            occurrences_at_last_notify: group.total,
          });
        }
        continue;
      }
      // Hook-only projects announce new groups, nothing else.
      if (!channels.length && !decision.first) continue;
      if (channels.length && sent >= MAX_MESSAGES_PER_RUN) break;

      // Claim before sending: a crash after this line loses a message rather than sending it twice.
      await store.saveState({
        tenant_id: tenant.id,
        project_id: project.id,
        fingerprint: group.fingerprint,
        first_notified_at: state?.first_notified_at ?? now,
        last_notified_at: now,
        occurrences_at_last_notify: group.total,
      });

      if (decision.first && withHook) {
        result.hooks++;
        notify('on-error-group-created', {
          workspace: { id: tenant.id, slug: tenant.slug, name: tenant.name },
          project: { id: project.id, slug: project.slug, name: project.name },
          group: {
            fingerprint: group.fingerprint,
            kind: group.kind,
            function: group.function,
            error_type: group.error_type,
            error_message: group.error_message.slice(0, 500),
            failure_kind: group.failure_kind,
            first_seen: new Date(group.first_seen).toISOString(),
            occurrences: group.total,
            sample_trace_id: group.sample_trace_id,
            url: baseUrl ? groupLink(ctx, group) : null,
          },
        });
      }

      if (!channels.length) continue;
      const stack = group.sample_trace_id ? await alertData().stackLine(scope, group.sample_trace_id, group.last_seen).catch(() => null) : null;
      const sinceMinutes = state ? Math.max(1, Math.round((now - state.last_notified_at) / 60_000)) : null;
      const message = formatGroupMessage(group, { ...ctx, sinceMinutes, stack }, decision.first);
      for (const channel of channels) {
        if (channel.status !== 'ok') continue;
        if (sent > 0 && options.spacingMs) await sleep(options.spacingMs);
        const delivery = await deliver(channel, message, slack!.secret, post);
        if (delivery.ok) result.messages++;
      }
      sent++;
    }
  }
  return result;
}

/** Sends to one channel; a webhook Slack says is gone is marked broken (the UI shows it) and skipped from then on. */
export async function deliver(channel: SlackIntegration, message: unknown, secret: string, post: (url: string, message: unknown) => Promise<Delivery>): Promise<Delivery> {
  let url: string;
  try {
    url = decrypt(channel.encrypted_webhook_url, secret);
  } catch {
    const delivery: Delivery = { ok: false, broken: true, error: 'The webhook URL can’t be decrypted (IVY_SECRET_KEY changed?); reconnect the channel' };
    await markBroken(channel, delivery.error);
    return delivery;
  }
  const delivery = await post(url, message);
  if (!delivery.ok) {
    console.error(`[alerts] slack ${channel.tenant_id}/${channel.project_id}/${channel.id} (#${channel.channel}): ${delivery.error}`);
    if (delivery.broken) await markBroken(channel, delivery.error);
  }
  return delivery;
}

async function markBroken(channel: SlackIntegration, error: string) {
  channel.status = 'broken';
  channel.error = error;
  await alertStore().saveIntegration(channel);
}
