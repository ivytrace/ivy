import { describe, expect, it } from "vitest";
import { describeSchedule } from "../../routes/settings/digest";
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

describe("describeSchedule", () => {
  it("reads simple weekly crons and falls back to the expression", () => {
    expect(describeSchedule("0 8 * * 1")).toBe("Mondays at 08:00 UTC");
    expect(describeSchedule("30 16 * * 5")).toBe("Fridays at 16:30 UTC");
    expect(describeSchedule("0 8 * * 7")).toBe("Sundays at 08:00 UTC");
    expect(describeSchedule("0 8 1 * *")).toBe("0 8 1 * * (cron, UTC)");
  });
});
