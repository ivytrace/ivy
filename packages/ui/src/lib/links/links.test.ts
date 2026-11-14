import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountLink,
  invocationsLink,
  legacyTarget,
  parseScope,
  pickProject,
  pickWorkspace,
  readLastScope,
  rowScope,
  switchProjectLink,
  traceLink,
  writeLastScope,
} from "./links";

describe("last-used scope", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("remembers a project per workspace", () => {
    expect(readLastScope()).toBeNull();
    writeLastScope({ workspace: "acme", project: "checkout-prod" });
    writeLastScope({ workspace: "side-project", project: "all" });
    writeLastScope({ workspace: "other" });
    expect(readLastScope()).toEqual({ workspace: "other" });
    expect(readLastScope("acme")).toEqual({ workspace: "acme", project: "checkout-prod" });
    expect(readLastScope("side-project")).toEqual({ workspace: "side-project", project: "all" });
    // A settings page keeps the workspace's project.
    writeLastScope({ workspace: "acme" });
    expect(readLastScope()).toEqual({ workspace: "acme", project: "checkout-prod" });
  });

  it("reads the format from before per-workspace projects", () => {
    localStorage.setItem("ivy.lastScope", JSON.stringify({ workspace: "acme", project: "billing" }));
    expect(readLastScope("acme")).toEqual({ workspace: "acme", project: "billing" });
    expect(readLastScope("other")).toEqual({ workspace: "other" });
  });
});

const scope = { workspace: "acme", project: "checkout-prod" };

describe("links", () => {
  it("builds scoped trace and filtered invocation links", () => {
    expect(traceLink(scope, "abc")).toBe("/w/acme/checkout-prod/traces/abc");
    expect(traceLink(scope, "abc", "s1")).toBe("/w/acme/checkout-prod/traces/abc?invocation=s1");
    expect(invocationsLink(scope)).toBe("/w/acme/checkout-prod/invocations");
    expect(invocationsLink(scope, { function: "a b", status: "error", q: "x'y" })).toBe(
      "/w/acme/checkout-prod/invocations?function=a+b&status=error&q=x%27y",
    );
    expect(accountLink("acme", "acc-1")).toBe("/w/acme/settings/aws/acc-1");
  });

  it("parses the scope of a path", () => {
    expect(parseScope("/w/acme/checkout-prod/traces/abc")).toEqual({ workspace: "acme", project: "checkout-prod" });
    expect(parseScope("/w/acme/all/functions")).toEqual({ workspace: "acme", project: "all" });
    expect(parseScope("/w/acme/settings/aws")).toEqual({ workspace: "acme", project: null });
    expect(parseScope("/w/acme")).toEqual({ workspace: "acme", project: null });
    expect(parseScope("/functions")).toBeNull();
  });
});

describe("legacy redirects", () => {
  it.each([
    ["/", "/w/acme/checkout-prod/functions"],
    ["/functions", "/w/acme/checkout-prod/functions"],
    ["/invocations", "/w/acme/checkout-prod/invocations"],
    ["/errors/", "/w/acme/checkout-prod/errors"],
    ["/traces/673f1a2b0000", "/w/acme/checkout-prod/traces/673f1a2b0000"],
    ["/settings", "/w/acme/settings/general"],
    ["/settings/aws", "/w/acme/settings/aws"],
    ["/settings/aws/acc-1", "/w/acme/settings/aws/acc-1"],
    ["/settings/notifications", "/w/acme/settings/notifications"],
    ["/settings/digest", "/w/acme/settings/notifications"],
  ])("%s → %s", (from, to) => {
    expect(legacyTarget(from, scope)).toBe(to);
  });

  it("leaves other paths alone", () => {
    expect(legacyTarget("/nope", scope)).toBeNull();
    expect(legacyTarget("/traces/a/b", scope)).toBeNull();
  });
});

describe("picking the scope to open", () => {
  const workspaces = [{ slug: "personal" }, { slug: "acme" }];
  const projects = [
    { slug: "default", default: true, archived: false },
    { slug: "checkout-prod", default: false, archived: false },
    { slug: "old", default: false, archived: true },
  ];

  it("prefers the last-used workspace, else the first", () => {
    expect(pickWorkspace(workspaces, { workspace: "acme" })?.slug).toBe("acme");
    expect(pickWorkspace(workspaces, { workspace: "gone" })?.slug).toBe("personal");
    expect(pickWorkspace(workspaces, null)?.slug).toBe("personal");
    expect(pickWorkspace([], null)).toBeNull();
  });

  it("prefers the last-used project of that workspace, else All projects", () => {
    expect(pickProject(projects, "acme", { workspace: "acme", project: "checkout-prod" })).toBe("checkout-prod");
    expect(pickProject(projects, "acme", { workspace: "acme", project: "all" })).toBe("all");
    // Without a remembered choice (another workspace, an archived or deleted project, none): All projects.
    expect(pickProject(projects, "acme", { workspace: "other", project: "checkout-prod" })).toBe("all");
    expect(pickProject(projects, "acme", { workspace: "acme", project: "old" })).toBe("all");
    expect(pickProject(projects, "acme", { workspace: "acme" })).toBe("all");
    expect(pickProject([projects[1]], "acme", null)).toBe("all");
    expect(pickProject([], "acme", null)).toBe("all");
  });
});

describe("all projects", () => {
  const all = { workspace: "acme", project: "all" };

  it("links rows of all-projects lists into their own project", () => {
    expect(traceLink(rowScope(all, { project: "checkout-staging" }), "abc", "s1")).toBe("/w/acme/checkout-staging/traces/abc?invocation=s1");
    expect(invocationsLink(rowScope(all, { project: "billing-api-prod" }), { function: "f" })).toBe("/w/acme/billing-api-prod/invocations?function=f");
    // Project-scoped rows carry no project and stay where they are.
    expect(rowScope(scope, {})).toEqual(scope);
  });

  it("keeps the list page when switching project, including to and from all", () => {
    expect(switchProjectLink("/w/acme/checkout-prod/invocations", all)).toBe("/w/acme/all/invocations");
    expect(switchProjectLink("/w/acme/all/errors", scope)).toBe("/w/acme/checkout-prod/errors");
    expect(switchProjectLink("/w/acme/all/functions/", scope)).toBe("/w/acme/checkout-prod/functions");
  });

  it("opens Functions when the page makes no sense in the target (a trace, settings)", () => {
    expect(switchProjectLink("/w/acme/checkout-prod/traces/abc", all)).toBe("/w/acme/all/functions");
    expect(switchProjectLink("/w/acme/settings/projects", all)).toBe("/w/acme/all/functions");
    expect(switchProjectLink("/w/acme/settings/general", scope)).toBe("/w/acme/checkout-prod/functions");
  });

  it("sends old links to all projects when that was the last choice", () => {
    expect(legacyTarget("/invocations", all)).toBe("/w/acme/all/invocations");
    expect(legacyTarget("/traces/abc", all)).toBe("/w/acme/all/traces/abc");
  });
});
