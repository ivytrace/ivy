import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { AlertsResponse, DigestInfo, Project } from "@/lib/api/types";
import { DigestCard, SlackRow, YourEmailCard } from "./notifications";
import { mergedSettingsRoutes } from "./redirects";

const digest = (extra: Partial<DigestInfo> = {}): DigestInfo => ({
  available: true,
  missing: [],
  schedule: "0 8 * * 1",
  enabled: true,
  can_edit: true,
  subscribed: true,
  recipients: 3,
  ...extra,
});

const noop = () => {};
const html = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const switchOf = (s: string, label: string) => new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(s)?.[0] ?? "";

describe("weekly email digest", () => {
  it("lets owners switch it, with the schedule, recipients and a preview", () => {
    const out = html(<DigestCard digest={digest()} configured busy={false} previewing={false} onToggle={noop} onPreview={noop} />);
    expect(text(out)).toContain("Mondays at 08:00 UTC");
    expect(text(out)).toContain("3 recipients");
    expect(text(out)).toContain("Preview this week's digest");
    expect(text(out)).not.toContain("Only workspace owners");
    expect(switchOf(out, "Send this workspace&#x27;s weekly digest")).not.toContain('disabled=""');
  });

  it("is read-only for members", () => {
    const out = html(<DigestCard digest={digest({ can_edit: false })} configured busy={false} previewing={false} onToggle={noop} onPreview={noop} />);
    expect(text(out)).toContain("Only workspace owners can change this.");
    expect(switchOf(out, "Send this workspace&#x27;s weekly digest")).toContain('disabled=""');
  });

  it("explains what is missing without email, and still previews", () => {
    const d = digest({ available: false, missing: ["IVY_SMTP_URL", "IVY_EMAIL_FROM"] });
    const out = html(<DigestCard digest={d} configured={false} busy={false} previewing={false} onToggle={noop} onPreview={noop} />);
    expect(text(out)).toContain("Email is not set up on this server");
    expect(text(out)).toContain("IVY_SMTP_URL");
    expect(text(out)).toContain("Preview this week's digest");
    expect(switchOf(out, "Send this workspace&#x27;s weekly digest")).toBe("");
  });
});

describe("your email", () => {
  it("is a switch every member can change", () => {
    const out = html(<YourEmailCard digest={digest({ can_edit: false, subscribed: false })} email="you@example.com" busy={false} onToggle={noop} />);
    expect(text(out)).toContain("Send the weekly digest to me (you@example.com)");
    const sw = switchOf(out, "Send the weekly digest to me");
    expect(sw).not.toContain('disabled=""');
    expect(sw).toContain('aria-checked="false"');
  });

  it("says when the workspace digest is off", () => {
    expect(text(html(<YourEmailCard digest={digest({ enabled: false })} email={null} busy={false} onToggle={noop} />))).toContain(
      "switched off for this workspace",
    );
  });

  it("points to IVY_DIGEST_TO without sign-in", () => {
    const out = html(<YourEmailCard digest={digest({ subscribed: null })} email={null} busy={false} onToggle={noop} />);
    expect(text(out)).toContain("IVY_DIGEST_TO");
    expect(switchOf(out, "Send the weekly digest to me")).toBe("");
  });
});

describe("slack alerts per project", () => {
  const project: Project = { id: "prj_1", slug: "checkout-prod", name: "Checkout (prod)", archived: false, created_at: "2026-11-01T00:00:00.000Z" };
  const alerts = (integrations: AlertsResponse["integrations"]): AlertsResponse => ({
    available: { slack: true, missing: [] },
    can_edit: true,
    settings: { slack_enabled: true, interval_minutes: 60, every_occurrences: 100, include_throttles: false },
    integrations,
  });
  const channel = (name: string, status: "ok" | "broken" = "ok") => ({
    id: `slk_${name}`,
    team_name: "Acme",
    channel: name,
    status,
    error: null,
    configuration_url: null,
    created_at: "2026-11-01T00:00:00.000Z",
  });

  it("shows the connected channel and links to the project's alerts", () => {
    const out = html(<SlackRow workspace="acme" project={project} alerts={alerts([channel("#checkout-alerts")])} />);
    expect(out).toContain('href="/w/acme/settings/alerts/checkout-prod"');
    expect(text(out)).toContain("checkout-alerts");
    expect(text(out)).toContain("Connected");
  });

  it("says Not connected, or Broken", () => {
    expect(text(html(<SlackRow workspace="acme" project={project} alerts={alerts([])} />))).toContain("Not connected");
    expect(text(html(<SlackRow workspace="acme" project={project} alerts={alerts([channel("#billing", "broken")])} />))).toContain("Broken");
  });
});

describe("merged settings pages", () => {
  it("redirects the old Email digest page to Notifications", async () => {
    const router = createMemoryRouter([{ path: "/w/:workspace/settings", children: [{ path: "notifications", element: null }, ...mergedSettingsRoutes] }], {
      initialEntries: ["/w/acme/settings/digest"],
    });
    await router.navigate("/w/acme/settings/digest");
    expect(router.state.location.pathname).toBe("/w/acme/settings/notifications");
  });
});
