import { afterEach, describe, expect, it, vi } from "vitest";

import { preselectProject, readLastTraceProject, rememberTraceProject } from "./last-project";

const projects = [{ slug: "checkout-prod" }, { slug: "checkout-staging" }];

describe("preselecting a project for tracing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes the first candidate that is an existing project, else none", () => {
    expect(preselectProject(projects, "api-prod", "checkout-staging", "checkout-prod")).toBe("checkout-staging");
    expect(preselectProject(projects, null, undefined, "checkout-prod")).toBe("checkout-prod");
    expect(preselectProject(projects, "gone")).toBe("");
    expect(preselectProject([], "checkout-prod")).toBe("");
  });

  it("remembers the last project per workspace, and survives blocked storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    rememberTraceProject("acme", "checkout-prod");
    expect(readLastTraceProject("acme")).toBe("checkout-prod");
    expect(readLastTraceProject("other")).toBeNull();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readLastTraceProject("acme")).toBeNull();
    expect(() => rememberTraceProject("acme", "x")).not.toThrow();
  });
});
