import type { AlertSettings, ErrorGroup, SlackChannel } from "../api/types.ts";
import type { MockWorkspace } from "./workspaces.ts";

/** Mock alerts: Slack channels and settings per project, the digest per workspace, your opt-outs. */

const DEFAULTS: AlertSettings = { slack_enabled: true, interval_minutes: 60, every_occurrences: 100, include_throttles: false };
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

interface ProjectAlerts {
  settings: AlertSettings;
  integrations: SlackChannel[];
}

let counter = 0;
const channel = (name: string, ageDays: number, extra: Partial<SlackChannel> = {}): SlackChannel => ({
  id: `slk_mock${(++counter).toString(36).padStart(6, "0")}`,
  team_name: "Acme",
  channel: name,
  status: "ok",
  error: null,
  configuration_url: "https://acme.slack.com/services/B0MOCK",
  created_at: iso(Date.now() - ageDays * DAY),
  ...extra,
});

export function createAlertsMock(options: { configured: boolean }) {
  const projects = new Map<string, ProjectAlerts>();
  const digest = new Map<string, boolean>();
  const optedOut = new Set<string>();

  // The seeded `acme` workspace: checkout-prod posts to #checkout-alerts; billing-api-prod's channel was archived.
  const seed = (ws: MockWorkspace, project: string): ProjectAlerts => {
    const list: SlackChannel[] = [];
    if (ws.slug === "acme" && project === "checkout-prod") list.push(channel("#checkout-alerts", 20));
    if (ws.slug === "acme" && project === "billing-api-prod") {
      list.push(channel("#billing", 40, { status: "broken", error: "HTTP 410 channel_is_archived" }));
    }
    return { settings: { ...DEFAULTS }, integrations: options.configured ? list : [] };
  };

  const of = (ws: MockWorkspace, project: string) => {
    const key = `${ws.id}/${project}`;
    let entry = projects.get(key);
    if (!entry) {
      entry = seed(ws, project);
      projects.set(key, entry);
    }
    return entry;
  };

  const missingSlack = options.configured ? [] : ["IVY_SLACK_CLIENT_ID", "IVY_SLACK_CLIENT_SECRET"];
  const missingEmail = options.configured ? [] : ["IVY_SMTP_URL", "IVY_EMAIL_FROM"];

  return {
    config: { slack: options.configured, email: options.configured },
    projectRoutes(ws: MockWorkspace, project: string, rest: string, method: string, body: Record<string, unknown>) {
      const entry = of(ws, project);
      const owner = ws.role === "owner";
      if (rest === "/alerts" && method === "GET") {
        return { status: 200, body: { available: { slack: options.configured, missing: missingSlack }, can_edit: owner, ...entry } };
      }
      if (!owner && rest.startsWith("/alerts")) return { status: 403, body: { error: "Only workspace owners can do this" } };
      if (rest === "/alerts" && method === "PUT") {
        entry.settings = { ...entry.settings, ...(body as Partial<AlertSettings>) };
        return { status: 200, body: entry.settings };
      }
      if (rest === "/alerts/slack/connect" && method === "POST") {
        if (!options.configured) return { status: 409, body: { error: "Slack is not configured on this server" } };
        // Stands in for Slack's authorize page: the user picks #alerts and comes straight back.
        entry.integrations.push(channel(entry.integrations.some((c) => c.channel === "#alerts") ? "#alerts-2" : "#alerts", 0));
        return { status: 200, body: { url: `/w/${ws.slug}/settings/alerts/${project}?slack=connected` } };
      }
      const one = rest.match(/^\/alerts\/slack\/([^/]+)(\/test)?$/);
      if (one) {
        const c = entry.integrations.find((x) => x.id === one[1]);
        if (!c) return { status: 404, body: { error: "Slack channel not found" } };
        if (one[2] && method === "POST") {
          return c.status === "broken"
            ? { status: 200, body: { ok: false, error: c.error, integration: c } }
            : { status: 200, body: { ok: true, error: null, integration: c } };
        }
        if (!one[2] && method === "DELETE") {
          entry.integrations.splice(entry.integrations.indexOf(c), 1);
          return { status: 200, body: { removed: true } };
        }
      }
      return null;
    },
    workspaceRoutes(ws: MockWorkspace, rest: string, method: string, body: Record<string, unknown>, errors: () => ErrorGroup[]) {
      const owner = ws.role === "owner";
      if (rest === "/digest" && method === "GET") {
        return {
          status: 200,
          body: {
            available: options.configured,
            missing: missingEmail,
            schedule: "0 8 * * 1",
            enabled: digest.get(ws.id) ?? true,
            can_edit: owner,
            subscribed: !optedOut.has(ws.id),
            recipients: ws.members.filter((m) => !(m.you && optedOut.has(ws.id))).length,
          },
        };
      }
      if (rest === "/digest" && method === "PUT") {
        if (!owner) return { status: 403, body: { error: "Only workspace owners can do this" } };
        digest.set(ws.id, body.enabled === true);
        return { status: 200, body: { enabled: body.enabled === true } };
      }
      if (rest === "/digest/preview" && method === "GET") return { status: 200, body: digestPreview(ws, errors()) };
      return null;
    },
    notifications(workspaces: MockWorkspace[], method: string, body: Record<string, unknown>) {
      if (method === "PUT") {
        const ws = workspaces.find((w) => w.slug === body.workspace || w.id === body.workspace);
        if (!ws) return { status: 404, body: { error: "Workspace not found" } };
        if (body.digest === false) optedOut.add(ws.id);
        else optedOut.delete(ws.id);
        return { status: 200, body: { workspace: { id: ws.id, slug: ws.slug, name: ws.name }, digest: body.digest !== false } };
      }
      return {
        status: 200,
        body: {
          email: "you@example.com",
          digest_available: options.configured,
          items: workspaces.map((w) => ({ workspace: { id: w.id, slug: w.slug, name: w.name }, digest: !optedOut.has(w.id) })),
        },
      };
    },
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A stand-in for the API's digest email (same layout, mock numbers). */
function digestPreview(ws: MockWorkspace, groups: ErrorGroup[]) {
  const errors = groups.filter((g) => g.kind === "error").reduce((n, g) => n + g.count, 0);
  const throttles = groups.filter((g) => g.kind === "throttle").reduce((n, g) => n + g.count, 0);
  const weekAgo = Date.now() - 7 * DAY;
  const fresh = groups.filter((g) => Date.parse(g.first_seen) >= weekAgo - DAY && g.kind === "error").slice(0, 3);
  const top = groups.slice(0, 6);
  const row = (g: ErrorGroup) => `<tr><td style="padding:10px 0;border-top:1px solid #e4e4e7;">
  <a href="#" style="color:#15803d;font-weight:600;text-decoration:none;">${esc(g.error_type)}</a>
  <div style="color:#27272a;font-size:13px;margin-top:2px;">${esc((g.variants > 1 ? g.error_template : g.error_message).slice(0, 160))}${g.variants > 1 ? ` (${g.variants} variants)` : ""}</div>
  <div style="color:#71717a;font-size:12px;margin-top:2px;"><code>${esc(g.function)}</code> · ${esc(g.project ?? "checkout-prod")}</div>
</td><td style="padding:10px 0 10px 12px;border-top:1px solid #e4e4e7;text-align:right;vertical-align:top;font-size:13px;"><strong>${g.count}</strong><div style="color:#71717a;font-size:12px;">+${(g.count * 7) % 60}%</div></td></tr>`;
  const stat = (v: number, label: string, trend: string) =>
    `<td style="padding:12px 8px 12px 0;vertical-align:top;width:25%;"><div style="font-size:20px;font-weight:700;">${v.toLocaleString("en-US")}</div><div style="color:#71717a;font-size:12px;">${label}</div><div style="color:#71717a;font-size:12px;">${trend} vs last week</div></td>`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid #e4e4e7;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
<tr><td style="padding:24px 28px 8px;"><div style="font-size:13px;font-weight:700;color:#16a34a;">Ivy</div><h1 style="font-size:20px;margin:6px 0 2px;">Weekly digest: ${esc(ws.name)}</h1><div style="color:#71717a;font-size:13px;">Last seven days (UTC)</div></td></tr>
<tr><td style="padding:8px 28px 0;"><table role="presentation" width="100%"><tr>${stat(18_420, "Invocations", "+12%")}${stat(errors, "Errors", "+40%")}${stat(3, "Failures outside the handler", "new")}${stat(throttles, "Throttles", "−20%")}</tr></table></td></tr>
<tr><td style="padding:0 28px 8px;"><h2 style="font-size:15px;margin:28px 0 4px;">New error groups this week</h2><table role="presentation" width="100%" style="border-collapse:collapse;">${fresh.map(row).join("") || '<tr><td style="padding:10px 0;border-top:1px solid #e4e4e7;color:#71717a;font-size:13px;">None.</td></tr>'}</table>
<h2 style="font-size:15px;margin:28px 0 4px;">Top error groups</h2><table role="presentation" width="100%" style="border-collapse:collapse;">${top.map(row).join("")}</table></td></tr>
<tr><td style="padding:20px 28px 24px;color:#71717a;font-size:12px;border-top:1px solid #e4e4e7;">You get this because you are a member of ${esc(ws.name)} in Ivy. <a href="#" style="color:#15803d;">Notification settings</a> · <a href="#" style="color:#15803d;">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
  return {
    subject: `Ivy weekly digest for ${ws.name}: ${errors} errors, ${fresh.length} new groups`,
    html,
    text: `Ivy weekly digest: ${ws.name}`,
    period: { from: iso(weekAgo), to: iso(Date.now()) },
    empty: groups.length === 0,
  };
}
