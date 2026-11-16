import { describe, expect, it } from "vitest";
import { describeSchedule } from "../../routes/settings/notifications";
import { untracedSection } from "./alerts";
import { createMockHandler } from "./server";

function client(options: Parameters<typeof createMockHandler>[0] = {}) {
  const handle = createMockHandler(options);
  return <T>(method: string, path: string, body?: Record<string, unknown>) => {
    const res = handle(new URL(path, "http://mock"), { method, body });
    return { status: res.status, body: res.body as T };
  };
}

const P = "/api/w/acme/p/checkout-prod";

describe("mock API: alerts", () => {
  it("reports Slack and email as configured, with per-project channels and settings", () => {
    const call = client();
    expect(call<{ alerts: unknown }>("GET", "/api/config").body.alerts).toEqual({ slack: true, email: true });
    const alerts = call<{ available: { slack: boolean }; settings: { interval_minutes: number }; integrations: { channel: string }[] }>("GET", `${P}/alerts`).body;
    expect(alerts.available.slack).toBe(true);
    expect(alerts.settings.interval_minutes).toBe(60);
    expect(alerts.integrations.map((c) => c.channel)).toEqual(["#checkout-alerts"]);
    expect(call<{ integrations: { status: string }[] }>("GET", "/api/w/acme/p/billing-api-prod/alerts").body.integrations[0].status).toBe("broken");

    expect(call("PUT", `${P}/alerts`, { interval_minutes: 15 }).body).toMatchObject({ interval_minutes: 15, every_occurrences: 100 });
    expect(call<{ url: string }>("POST", `${P}/alerts/slack/connect`).body.url).toBe("/w/acme/settings/alerts/checkout-prod?slack=connected");
    const after = call<{ integrations: { id: string }[] }>("GET", `${P}/alerts`).body.integrations;
    expect(after).toHaveLength(2);
    expect(call("POST", `${P}/alerts/slack/${after[1].id}/test`).body).toMatchObject({ ok: true });
    expect(call("DELETE", `${P}/alerts/slack/${after[1].id}`).body).toEqual({ removed: true });
  });

  it("applies one rule to other projects, all or nothing, without copying channels", () => {
    const call = client();
    const projects = call<{ items: { id: string; slug: string; archived: boolean }[] }>("GET", "/api/w/acme/projects?archived=1").body.items;
    const id = (slug: string) => projects.find((p) => p.slug === slug)!.id;
    const rule = { slack_enabled: true, interval_minutes: 15, every_occurrences: 10, include_throttles: true };

    const res = call<{ updated: number; projects: { slug: string }[] }>("POST", "/api/w/acme/alerts/apply", {
      projects: [id("checkout-staging"), id("support-api-prod")],
      settings: rule,
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(call("GET", "/api/w/acme/p/support-api-prod/alerts").body).toMatchObject({ settings: rule, integrations: [] });
    expect(call<{ settings: unknown }>("GET", `${P}/alerts`).body.settings).toMatchObject({ interval_minutes: 60 });

    const archived = call<{ error: string }>("POST", "/api/w/acme/alerts/apply", { projects: [id("billing-api-staging"), id("legacy-reports")], settings: rule });
    expect(archived.status).toBe(400);
    expect(call<{ settings: unknown }>("GET", "/api/w/acme/p/billing-api-staging/alerts").body.settings).toMatchObject({ interval_minutes: 60 });
    expect(call("POST", "/api/w/acme/alerts/apply", { projects: [id("checkout-staging")], settings: { interval_minutes: 5 } }).status).toBe(400);
  });

  it("explains what is missing when the server has neither Slack nor email", () => {
    const call = client({ noAlerts: true });
    expect(call<{ alerts: unknown }>("GET", "/api/config").body.alerts).toEqual({ slack: false, email: false });
    expect(call<{ available: { missing: string[] } }>("GET", `${P}/alerts`).body.available.missing).toContain("IVY_SLACK_CLIENT_ID");
    expect(call("POST", `${P}/alerts/slack/connect`).status).toBe(409);
    expect(call<{ available: boolean }>("GET", "/api/w/acme/digest").body.available).toBe(false);
    expect(call<{ digest_available: boolean }>("GET", "/api/me/notifications").body.digest_available).toBe(false);
  });

  it("has the digest switch, a preview and your opt-out", () => {
    const call = client();
    expect(call("GET", "/api/w/acme/digest").body).toMatchObject({ enabled: true, schedule: "0 8 * * 1" });
    expect(call("PUT", "/api/w/acme/digest", { enabled: false }).body).toEqual({ enabled: false });
    const preview = call<{ html: string; subject: string }>("GET", "/api/w/acme/digest/preview").body;
    expect(preview.subject).toContain("Ivy weekly digest for");
    expect(preview.html).toContain("Top error groups");
    expect(call("PUT", "/api/me/notifications", { workspace: "acme", digest: false }).status).toBe(200);
    const mine = call<{ items: { workspace: { slug: string }; digest: boolean }[] }>("GET", "/api/me/notifications").body.items;
    expect(mine.find((i) => i.workspace.slug === "acme")?.digest).toBe(false);
    expect(call<{ subscribed: boolean }>("GET", "/api/w/acme/digest").body.subscribed).toBe(false);
  });
});

describe("mock digest preview: new functions not traced yet", () => {
  it("shows up to three names, then and N more, and nothing when there are none", () => {
    expect(untracedSection([])).toBe("");
    const text = (s: string) => s.replace(/<[^>]+>/g, "");
    expect(text(untracedSection(["a", "b"]))).toContain("a, b. Choose what to trace");
    expect(text(untracedSection(["a", "b", "c", "d", "e"]))).toContain("a, b, c and 2 more. Choose what to trace");
  });

  it("lists the seeded workspace's new untraced functions", () => {
    const call = client();
    expect(call<{ html: string }>("GET", "/api/w/acme/digest/preview").body.html).toContain("New functions not traced yet");
    expect(call<{ html: string }>("GET", "/api/w/side-project/digest/preview").body.html).not.toContain("not traced yet");
  });
});

describe("describeSchedule", () => {
  it("reads simple weekly crons and falls back to the expression", () => {
    expect(describeSchedule("0 8 * * 1")).toBe("Mondays at 08:00 UTC");
    expect(describeSchedule("30 16 * * 5")).toBe("Fridays at 16:30 UTC");
    expect(describeSchedule("0 8 * * 7")).toBe("Sundays at 08:00 UTC");
    expect(describeSchedule("0 8 1 * *")).toBe("0 8 1 * * (cron, UTC)");
  });
});
