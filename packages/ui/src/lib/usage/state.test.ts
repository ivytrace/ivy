import { describe, expect, it } from "vitest";
import { createMockHandler } from "../mock/server";
import { mockUsage } from "../mock/usage";
import type { Config, Usage } from "../api/types";
import { legacyTarget, usageLink } from "../links/links";
import { barPercent, billingAction, usageState } from "./state";

describe("usageState", () => {
  it("free under quota: ok, no banner", () => {
    expect(usageState(mockUsage("free"))).toMatchObject({ level: "ok", banner: null });
  });

  it("free at 80% or more: warning banner", () => {
    expect(usageState(mockUsage("near"))).toMatchObject({ level: "warning", banner: "warning" });
    const exactly80 = { ...mockUsage("free"), traces: 40_000 };
    expect(usageState(exactly80).banner).toBe("warning");
    expect(usageState({ ...exactly80, traces: 39_999 }).banner).toBeNull();
  });

  it("free over quota: blocked banner, bar full", () => {
    const state = usageState(mockUsage("over"));
    expect(state).toMatchObject({ level: "blocked", banner: "blocked" });
    expect(barPercent(state.ratio)).toBe(100);
    expect(barPercent(usageState({ ...mockUsage("over"), traces: 250_000 }).ratio)).toBe(100);
  });

  it("paid: never a banner, overage beyond the included traces", () => {
    expect(usageState(mockUsage("paid"))).toMatchObject({ level: "overage", banner: null });
    expect(usageState({ ...mockUsage("paid"), traces: 10 })).toMatchObject({ level: "included", banner: null });
  });

  it("unlimited: no bar, no banner", () => {
    const state = usageState(mockUsage("unlimited"));
    expect(state).toEqual({ level: "unlimited", ratio: null, banner: null });
    expect(barPercent(state.ratio)).toBe(0);
  });
});

describe("billing buttons", () => {
  it("only owners get one: Upgrade on free, Manage billing on paid", () => {
    expect(billingAction(mockUsage("free"), "owner")).toBe("checkout");
    expect(billingAction(mockUsage("over"), "owner")).toBe("checkout");
    expect(billingAction(mockUsage("unlimited"), "owner")).toBe("checkout");
    expect(billingAction(mockUsage("paid"), "owner")).toBe("portal");
    expect(billingAction(mockUsage("free"), "member")).toBeNull();
    expect(billingAction(mockUsage("paid"), "member")).toBeNull();
    expect(billingAction(mockUsage("free"), undefined)).toBeNull();
  });
});

describe("usage links", () => {
  it("lives in the workspace's settings; the old path redirects there", () => {
    expect(usageLink("acme")).toBe("/w/acme/settings/usage");
    expect(legacyTarget("/settings/usage", { workspace: "acme", project: "checkout-prod" })).toBe("/w/acme/settings/usage");
  });
});

describe("mock usage and billing", () => {
  const call = (handle: ReturnType<typeof createMockHandler>, path: string, method = "GET", body?: Record<string, unknown>) =>
    handle(new URL(path, "http://mock"), { method, body });

  it("serves the chosen usage fixture per workspace, and a billing URL", () => {
    const handle = createMockHandler({ usage: "over" });
    const usage = call(handle, "/api/w/acme/usage").body as Usage;
    expect(usage.blocked).toBe(true);
    expect(usage.workspace).toMatch(/^ten_/);
    expect((call(handle, "/api/config").body as Config).billing?.url).toBe("/api/mock-billing");
    expect(call(handle, "/api/w/nope/usage").status).toBe(404);
  });

  it("mock billing: owners get checkout and portal URLs back to the workspace's usage page, members 403", () => {
    const handle = createMockHandler();
    const acme = (call(handle, "/api/w/acme/usage").body as Usage).workspace;
    expect(call(handle, "/api/mock-billing/checkout", "POST", { workspace: acme }).body).toEqual({ url: "/w/acme/settings/usage?checkout=success" });
    expect(call(handle, "/api/mock-billing/portal", "POST", { workspace: acme }).body).toEqual({ url: "/w/acme/settings/usage" });
    const side = (call(handle, "/api/w/side-project/usage").body as Usage).workspace;
    expect(call(handle, "/api/mock-billing/checkout", "POST", { workspace: side }).status).toBe(403);
  });

  it("can leave out billing (no buttons)", () => {
    const handle = createMockHandler({ noBilling: true });
    expect((call(handle, "/api/config").body as Config).billing).toBeUndefined();
    expect((call(handle, "/api/w/acme/usage").body as Usage).limits.plan).toBe("Free");
  });
});
