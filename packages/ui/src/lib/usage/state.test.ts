import { describe, expect, it } from "vitest";
import { createMockHandler } from "../mock/server";
import { mockUsage } from "../mock/usage";
import type { Config, Usage } from "../api/types";
import { barPercent, usageState } from "./state";

describe("usageState", () => {
  it("free under quota: ok, no banner", () => {
    expect(usageState(mockUsage("free"))).toMatchObject({ level: "ok", banner: null });
  });

  it("free at 80% or more: warning banner", () => {
    expect(usageState(mockUsage("near"))).toMatchObject({ level: "warning", banner: "warning" });
    const exactly80 = { ...mockUsage("free"), traces: 80_000 };
    expect(usageState(exactly80).banner).toBe("warning");
    expect(usageState({ ...exactly80, traces: 79_999 }).banner).toBeNull();
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

describe("mock usage and billing", () => {
  const call = (handle: ReturnType<typeof createMockHandler>, path: string, method = "GET") =>
    handle(new URL(path, "http://mock"), { method });

  it("serves the chosen usage fixture and a billing URL", () => {
    const handle = createMockHandler({ usage: "over" });
    expect((call(handle, "/api/usage").body as Usage).blocked).toBe(true);
    const config = call(handle, "/api/config").body as Config;
    expect(config.billing?.url).toBe("/api/mock-billing");
    expect(call(handle, "/api/mock-billing/checkout", "POST").body).toEqual({ url: "/settings/usage?checkout=success" });
    expect(call(handle, "/api/mock-billing/portal", "POST").body).toEqual({ url: "/settings/usage" });
  });

  it("can leave out billing (no buttons)", () => {
    const handle = createMockHandler({ noBilling: true });
    expect((call(handle, "/api/config").body as Config).billing).toBeUndefined();
    expect((call(handle, "/api/usage").body as Usage).limits.plan).toBe("Free");
  });
});
