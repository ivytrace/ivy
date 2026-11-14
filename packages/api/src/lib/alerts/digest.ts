import { FAILURE_LABELS } from '@ivy/spans';
import { publicUrl } from '../aws/config.js';
import { sendEmail } from '../email/send.js';
import { DEFAULT_TENANT } from '../tenancy/tenants.js';
import { multiWorkspaceMode } from '../tenancy/members.js';
import { tenancyStore, type TenantRecord } from '../tenancy/store.js';
import { digestCron, digestEnabled, digestExtraRecipients, signingSecret } from './config.js';
import { lastRun, parseCron } from './cron.js';
import { alertData, groupMessage, type DigestData, type DigestGroup, type DigestTotals } from './data.js';
import { sign, verify } from './signing.js';
import { alertStore } from './store.js';

/** The weekly email digest (docs/implementation/alerts.md, "Weekly digest"). */

const DAY = 86_400_000;
const enc = encodeURIComponent;

export interface DigestPeriod {
  from: number;
  to: number;
  /** `YYYY-MM-DD` of `to`: the idempotency key of a workspace's digest. */
  key: string;
}

/** The seven days before the start (00:00 UTC) of the day the digest runs. */
export function digestPeriod(runAt: number): DigestPeriod {
  const to = Math.floor(runAt / DAY) * DAY;
  return { from: to - 7 * DAY, to, key: new Date(to).toISOString().slice(0, 10) };
}

export interface Recipient {
  sub: string;
  email: string;
}

/**
 * Who gets a workspace's digest: its members with an email (multi-workspace mode) or the users who
 * signed in (single-workspace mode, remembered in notification_prefs), plus IVY_DIGEST_TO for the
 * default workspace; minus everyone who opted out.
 */
export async function digestRecipients(tenantId: string): Promise<Recipient[]> {
  const prefs = await alertStore().listPrefs(tenantId);
  const optedOut = new Set(prefs.filter((p) => !p.digest).map((p) => p.sub));
  const candidates: Recipient[] = multiWorkspaceMode()
    ? (await tenancyStore().listMembers(tenantId)).filter((m) => m.email).map((m) => ({ sub: m.sub, email: m.email }))
    : prefs.filter((p) => p.email && !p.sub.startsWith('email:')).map((p) => ({ sub: p.sub, email: p.email }));
  if (tenantId === DEFAULT_TENANT) candidates.push(...digestExtraRecipients().map((email) => ({ sub: `email:${email}`, email })));
  const seen = new Set<string>();
  return candidates.filter((r) => {
    const key = r.email.toLowerCase();
    if (optedOut.has(r.sub) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function unsubscribeToken(tenantId: string, sub: string): string | null {
  const secret = signingSecret();
  return secret ? sign({ t: tenantId, s: sub }, secret, 'digest-unsubscribe') : null;
}

export function readUnsubscribeToken(token: string): { tenant: string; sub: string } | null {
  const secret = signingSecret();
  const payload = secret ? verify<{ t?: unknown; s?: unknown }>(token, secret, 'digest-unsubscribe') : null;
  return payload && typeof payload.t === 'string' && typeof payload.s === 'string' ? { tenant: payload.t, sub: payload.s } : null;
}

export interface DigestModel {
  workspace: { slug: string; name: string };
  period: DigestPeriod;
  totals: DigestTotals;
  previous: DigestTotals;
  newGroups: DigestGroup[];
  topGroups: DigestGroup[];
  /** Project ID → slug and name. */
  projects: Map<string, { slug: string; name: string }>;
}

export async function buildDigest(tenant: TenantRecord, period: DigestPeriod): Promise<DigestModel> {
  const data: DigestData = await alertData().digest({ tenant: { id: tenant.id, shardId: tenant.shard_id }, projectId: null }, period);
  const projects = new Map((await tenancyStore().listProjects(tenant.id)).map((p) => [p.id, { slug: p.slug, name: p.name }]));
  return {
    workspace: { slug: tenant.slug, name: tenant.name },
    period,
    totals: data.totals,
    previous: data.previous,
    newGroups: data.groups.filter((g) => g.first_seen >= period.from).slice(0, 10),
    topGroups: data.groups.slice(0, 10),
    projects,
  };
}

/** No invocations and no throttles in the period: nothing to report. */
export const isEmptyDigest = (m: DigestModel) => m.totals.invocations === 0 && m.totals.throttles === 0;

export interface RenderLinks {
  baseUrl: string;
  unsubscribeUrl: string | null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const trim = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const n = (v: number) => v.toLocaleString('en-US');
const variantsNote = (g: DigestGroup) => (g.variants > 1 ? ` (${n(g.variants)} variants)` : '');
const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "+40%", "−12%", "new" or "same" against last week. */
export function trend(count: number, previous: number): string {
  if (previous === 0) return count === 0 ? 'same' : 'new';
  const pct = Math.round(((count - previous) / previous) * 100);
  if (pct === 0) return 'same';
  return pct > 0 ? `+${pct}%` : `−${Math.abs(pct)}%`;
}

const groupTitle = (g: DigestGroup) =>
  g.kind === 'throttle' ? 'Throttled' : g.failure_kind ? `${FAILURE_LABELS[g.failure_kind]}: ${g.error_type}` : g.error_type;

function groupUrl(m: DigestModel, g: DigestGroup, baseUrl: string) {
  const project = m.projects.get(g.project_id)?.slug ?? 'all';
  const base = `${baseUrl}/w/${enc(m.workspace.slug)}/${enc(project)}`;
  return g.sample_trace_id && project !== 'all' ? `${base}/traces/${enc(g.sample_trace_id)}` : `${base}/errors?function=${enc(g.function)}`;
}

const subjectOf = (m: DigestModel) =>
  `Ivy weekly digest for ${m.workspace.name}: ${n(m.totals.errors)} error${m.totals.errors === 1 ? '' : 's'}, ${m.newGroups.length} new group${m.newGroups.length === 1 ? '' : 's'}`;

/**
 * The digest as HTML (table layout and inline styles, light background, for email clients) and as
 * plain text. Only types, trimmed messages, function and project names, counts and links: no payloads.
 */
export function renderDigest(m: DigestModel, links: RenderLinks) {
  const range = `${day(m.period.from)} – ${day(m.period.to - 1)}`;
  const totals: [string, keyof DigestTotals][] = [
    ['Invocations', 'invocations'],
    ['Errors', 'errors'],
    ['Failures outside the handler', 'failures'],
    ['Throttles', 'throttles'],
  ];
  const settingsUrl = `${links.baseUrl}/w/${enc(m.workspace.slug)}/settings/notifications`;
  const projectName = (g: DigestGroup) => m.projects.get(g.project_id)?.name ?? 'unknown project';

  const text = [
    `Ivy weekly digest: ${m.workspace.name}`,
    range,
    '',
    ...totals.map(([label, k]) => `${label}: ${n(m.totals[k])} (${trend(m.totals[k], m.previous[k])} vs last week)`),
    '',
    'New error groups this week',
    ...(m.newGroups.length
      ? m.newGroups.map((g) => `- ${groupTitle(g)}: ${trim(groupMessage(g), 120)}${variantsNote(g)}\n  ${g.function} · ${projectName(g)} · ${n(g.count)}×\n  ${groupUrl(m, g, links.baseUrl)}`)
      : ['None.']),
    '',
    'Top error groups',
    ...(m.topGroups.length
      ? m.topGroups.map(
          (g) => `- ${n(g.count)}× (${trend(g.count, g.previous)}) ${groupTitle(g)}: ${trim(groupMessage(g), 120)}${variantsNote(g)}\n  ${g.function} · ${projectName(g)}\n  ${groupUrl(m, g, links.baseUrl)}`,
        )
      : ['No errors this week.']),
    '',
    `Notification settings: ${settingsUrl}`,
    ...(links.unsubscribeUrl ? [`Unsubscribe: ${links.unsubscribeUrl}`] : []),
  ].join('\n');

  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  const muted = 'color:#71717a;';
  const groupRows = (groups: DigestGroup[], withTrend: boolean) =>
    groups
      .map(
        (g) => `<tr><td style="padding:10px 0;border-top:1px solid #e4e4e7;">
  <a href="${esc(groupUrl(m, g, links.baseUrl))}" style="color:#15803d;font-weight:600;text-decoration:none;">${esc(trim(groupTitle(g), 100))}</a>
  <div style="color:#27272a;font-size:13px;margin-top:2px;">${esc(trim(groupMessage(g), 160))}${esc(variantsNote(g))}</div>
  <div style="${muted}font-size:12px;margin-top:2px;"><code style="font-family:Menlo,Consolas,monospace;">${esc(trim(g.function, 80))}</code> · ${esc(projectName(g))}</div>
</td><td style="padding:10px 0 10px 12px;border-top:1px solid #e4e4e7;text-align:right;white-space:nowrap;vertical-align:top;font-size:13px;">
  <strong>${n(g.count)}</strong>${withTrend ? `<div style="${muted}font-size:12px;">${esc(trend(g.count, g.previous))}</div>` : ''}
</td></tr>`,
      )
      .join('');
  const section = (title: string, body: string) =>
    `<h2 style="font-size:15px;margin:28px 0 4px;color:#18181b;">${esc(title)}</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${body}</table>`;
  const empty = (msg: string) => `<tr><td style="padding:10px 0;border-top:1px solid #e4e4e7;${muted}font-size:13px;">${esc(msg)}</td></tr>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><title>${esc(subjectOf(m))}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;${font}color:#18181b;">
<tr><td style="padding:24px 28px 8px;">
  <div style="font-size:13px;font-weight:700;color:#16a34a;letter-spacing:0.02em;">Ivy</div>
  <h1 style="font-size:20px;margin:6px 0 2px;">Weekly digest: ${esc(m.workspace.name)}</h1>
  <div style="${muted}font-size:13px;">${esc(range)} (UTC)</div>
</td></tr>
<tr><td style="padding:8px 28px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
  <tr>${totals
    .map(
      ([label, k]) => `<td style="padding:12px 8px 12px 0;vertical-align:top;width:25%;">
    <div style="font-size:20px;font-weight:700;">${n(m.totals[k])}</div>
    <div style="${muted}font-size:12px;">${esc(label)}</div>
    <div style="${muted}font-size:12px;">${esc(trend(m.totals[k], m.previous[k]))} vs last week</div></td>`,
    )
    .join('')}</tr></table>
</td></tr>
<tr><td style="padding:0 28px 8px;">
  ${section('New error groups this week', m.newGroups.length ? groupRows(m.newGroups, false) : empty('None.'))}
  ${section('Top error groups', m.topGroups.length ? groupRows(m.topGroups, true) : empty('No errors this week.'))}
</td></tr>
<tr><td style="padding:20px 28px 24px;${muted}font-size:12px;border-top:1px solid #e4e4e7;">
  You get this because you are a member of ${esc(m.workspace.name)} in Ivy.
  <a href="${esc(settingsUrl)}" style="color:#15803d;">Notification settings</a>${
    links.unsubscribeUrl ? ` · <a href="${esc(links.unsubscribeUrl)}" style="color:#15803d;">Unsubscribe</a>` : ''
  }
</td></tr>
</table></td></tr></table>
</body></html>`;

  return { subject: subjectOf(m), html, text };
}

export const unsubscribeUrl = (baseUrl: string, token: string | null) => (token ? `${baseUrl}/api/digest/unsubscribe?token=${enc(token)}` : null);

export interface DigestRunResult {
  workspaces: number;
  emails: number;
  skipped: number;
}

/**
 * Sends the digests that are due: the latest scheduled run (IVY_DIGEST_CRON) within the last day,
 * per workspace once (digest_sends), skipping workspaces that are switched off, had no data in the
 * period or have no recipients.
 */
const handled = new Set<string>();

export const resetDigestRunsForTests = () => handled.clear();

export async function sendDueDigests(now = Date.now()): Promise<DigestRunResult> {
  const result: DigestRunResult = { workspaces: 0, emails: 0, skipped: 0 };
  if (!digestEnabled()) return result;
  const runAt = lastRun(parseCron(digestCron()), now, DAY);
  if (runAt === null) return result;
  const period = digestPeriod(runAt);
  const baseUrl = publicUrl()!;
  const store = alertStore();
  for (const tenant of await tenancyStore().listTenants()) {
    // Each workspace is looked at once per period and process (switching it on later in the day still counts).
    const key = `${tenant.id}/${period.key}`;
    if (handled.has(key)) continue;
    if (!(await store.getDigestEnabled(tenant.id))) continue;
    handled.add(key);
    if (await store.digestSent(tenant.id, period.key)) continue;
    const recipients = await digestRecipients(tenant.id);
    const model = recipients.length ? await buildDigest(tenant, period) : null;
    if (!model || isEmptyDigest(model)) {
      result.skipped++;
      continue;
    }
    // Claim before sending: a crash mid-way loses the rest of this week's digest rather than repeating it.
    await store.recordDigest(tenant.id, period.key, recipients.length);
    result.workspaces++;
    for (const r of recipients) {
      const unsubscribe = unsubscribeUrl(baseUrl, unsubscribeToken(tenant.id, r.sub));
      const { subject, html, text } = renderDigest(model, { baseUrl, unsubscribeUrl: unsubscribe });
      try {
        await sendEmail({
          to: r.email,
          subject,
          html,
          text,
          headers: unsubscribe ? { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {},
        });
        result.emails++;
      } catch (err) {
        console.error(`[digest] ${tenant.id} to ${r.email}: ${(err as Error).message}`);
      }
    }
  }
  return result;
}
