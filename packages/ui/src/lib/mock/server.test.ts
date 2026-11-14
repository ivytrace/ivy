import { describe, expect, it, vi } from "vitest";
import { createMockHandler } from "./server";
import type {
  AwsAccount,
  AwsFunction,
  DryRunResponse,
  ErrorGroup,
  FunctionGroup,
  FunctionSummary,
  InvocationsResponse,
  Project,
  Rule,
  Trace,
  VerifyResponse,
  Workspace,
} from "../api/types";
import { describeSpan, getLogs, llmUsage } from "../spans/services";

function client(options: Parameters<typeof createMockHandler>[0] = {}) {
  const handle = createMockHandler(options);
  return <T>(method: string, path: string, body?: Record<string, unknown>) => {
    const res = handle(new URL(path, "http://mock"), { method, body });
    return { status: res.status, body: res.body as T };
  };
}

const P = "/api/w/acme/p/checkout-prod";

describe("mock API: workspaces and data", () => {
  it("serves two workspaces with projects, members and invitations", () => {
    const call = client();
    expect(call<{ items: Workspace[] }>("GET", "/api/workspaces").body.items.map((w) => w.slug)).toEqual(["acme", "side-project"]);
    const projects = call<{ items: Project[] }>("GET", "/api/w/acme/projects").body.items.map((p) => p.slug);
    expect(projects).toEqual(expect.arrayContaining(["checkout-prod", "checkout-staging", "billing-api-prod", "billing-api-staging", "default"]));
    expect(projects).not.toContain("legacy-reports");
    expect(call<{ items: unknown[] }>("GET", "/api/w/acme/members").body.items.length).toBeGreaterThan(1);
    expect(call<{ items: unknown[] }>("GET", "/api/w/acme/invitations").body.items).toHaveLength(1);
    expect(call("GET", "/api/w/nope/projects").status).toBe(404);
  });

  it("serves project-scoped data with cursor pagination and filters", () => {
    const call = client();
    const fns = call<{ items: FunctionSummary[] }>("GET", `${P}/functions?since=7d`).body.items;
    expect(fns.map((f) => f.name).sort()).toEqual(["checkout-createOrder", "orders-processQueue"]);

    const page1 = call<InvocationsResponse>("GET", `${P}/invocations?since=7d&limit=10`).body;
    expect(page1.items).toHaveLength(10);
    const page2 = call<InvocationsResponse>("GET", `${P}/invocations?since=7d&limit=10&cursor=${page1.next_cursor}`).body;
    expect(page2.items[0].ts <= page1.items[9].ts).toBe(true);
    const errors = call<InvocationsResponse>("GET", `${P}/invocations?since=7d&status=error&function=checkout-createOrder`).body;
    expect(errors.items.every((i) => i.status === "error" && i.function === "checkout-createOrder")).toBe(true);

    // Other projects don't see it; all projects do, labelled.
    expect(call<{ items: FunctionSummary[] }>("GET", "/api/w/acme/p/billing-api-prod/functions?since=7d").body.items.map((f) => f.name)).not.toContain(
      "orders-processQueue",
    );
    const all = call<{ items: FunctionSummary[] }>("GET", "/api/w/acme/functions?since=7d").body.items;
    expect(new Set(all.map((f) => f.project))).toEqual(
      new Set(["checkout-prod", "checkout-staging", "billing-api-prod", "billing-api-staging", "support-api-prod"]),
    );
    // One function name in two projects: two rows.
    expect(all.filter((f) => f.name === "checkout-createOrder").map((f) => f.project).sort()).toEqual(["checkout-prod", "checkout-staging"]);
    expect(call<{ items: ErrorGroup[] }>("GET", "/api/w/acme/errors?since=7d").body.items[0].project).toBeTruthy();
  });

  it("serves workspace-wide invocations and timeseries over every project", () => {
    const call = client();
    const page1 = call<InvocationsResponse>("GET", "/api/w/acme/invocations?since=7d&limit=50").body;
    expect(page1.items).toHaveLength(50);
    expect(page1.items.every((i) => i.project && i.project_id)).toBe(true);
    expect(new Set(page1.items.map((i) => i.project)).size).toBeGreaterThan(1);
    const page2 = call<InvocationsResponse>("GET", `/api/w/acme/invocations?since=7d&limit=50&cursor=${page1.next_cursor}`).body;
    expect(page2.items[0].ts <= page1.items[49].ts).toBe(true);
    expect(call<InvocationsResponse>("GET", `${P}/invocations?since=7d&limit=5`).body.items[0]).not.toHaveProperty("project");

    const failed = call<InvocationsResponse>("GET", "/api/w/acme/invocations?since=7d&status=error").body.items;
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((i) => i.status === "error")).toBe(true);

    const sum = (path: string) => call<{ items: { invocations: number }[] }>("GET", path).body.items.reduce((n, p) => n + p.invocations, 0);
    const ws = sum("/api/w/acme/stats/timeseries?since=7d&function=checkout-createOrder");
    const prod = sum("/api/w/acme/stats/timeseries?since=7d&function=checkout-createOrder&project=checkout-prod");
    const staging = sum("/api/w/acme/stats/timeseries?since=7d&function=checkout-createOrder&project=checkout-staging");
    expect(prod).toBeGreaterThan(0);
    expect(staging).toBeGreaterThan(0);
    expect(ws).toBe(prod + staging);
    expect(sum("/api/w/acme/stats/timeseries?since=7d")).toBeGreaterThan(ws);
    expect(call("GET", "/api/w/acme/stats/timeseries?project=nope").status).toBe(404);
    expect(call("GET", "/api/w/acme/traces/abc").status).toBe(404);
  });

  it("serves a rich trace for an error group sample, only in its project", () => {
    const call = client();
    const groups = call<{ items: ErrorGroup[] }>("GET", `${P}/errors?since=7d`).body.items;
    const checkout = groups.find((g) => g.function === "checkout-createOrder")!;
    const trace = call<Trace>("GET", `${P}/traces/${checkout.sample_trace_id}`).body;
    const icons = trace.spans.map((s) => describeSpan(s).icon);
    expect(icons).toContain("dynamodb");
    expect(getLogs(trace.spans).length).toBeGreaterThan(0);
    expect(call("GET", `/api/w/acme/p/billing-api-prod/traces/${checkout.sample_trace_id}`).status).toBe(404);
  });

  it("serves an AI SDK trace: generateText with a tool call, then streamText", () => {
    const call = client();
    const base = "/api/w/acme/p/support-api-prod";
    const inv = call<InvocationsResponse>("GET", `${base}/invocations?since=7d&status=ok&function=support-answerTicket`).body.items[0];
    const spans = call<Trace>("GET", `${base}/traces/${inv.trace_id}`).body.spans;
    expect(spans.map((s) => s.name)).toEqual(
      expect.arrayContaining(["ai.generateText", "ai.generateText.doGenerate", "ai.toolCall", "ai.streamText.doStream", "DynamoDB.GetItem"]),
    );
    expect(llmUsage(spans)).toMatchObject({ calls: 3, inputTokens: 1877, outputTokens: 103 });
    const tool = spans.find((s) => s.name === "ai.toolCall")!;
    expect(spans.find((s) => s.name === "DynamoDB.GetItem")!.parent_span_id).toBe(tool.span_id);
    expect(describeSpan(spans.find((s) => s.name === "ai.streamText.doStream")!).llm?.ttftMs).toBeGreaterThan(200);
  });

  it("creates projects, keys and invitations", () => {
    const call = client();
    expect(call<Project>("POST", "/api/w/acme/projects", { name: "Billing (prod)" }).body.slug).toBe("billing-prod");
    expect(call<Project>("POST", "/api/w/acme/projects", { name: "Checkout prod" }).body.slug).toBe("checkout-prod-2");
    const key = call<{ key: string }>("POST", "/api/w/acme/p/billing-prod/keys", { name: "ci" });
    expect(key.status).toBe(201);
    expect(key.body.key).toMatch(/^ivy_/);
    const inv = call<{ url: string }>("POST", "/api/w/acme/invitations", { email: "new@example.com" }).body;
    const token = inv.url.split("/invite/")[1];
    expect(call<{ status: string }>("GET", `/api/invitations/${token}`).body.status).toBe("pending");
    expect(call("POST", `/api/invitations/${token}/accept`).status).toBe(200);
    expect(call("POST", `/api/invitations/${token}/accept`).status).toBe(410);
  });

  it("moves the default project, also when the default is archived, and keeps one project", () => {
    const call = client();
    const defaultOf = () => call<{ items: Project[] }>("GET", "/api/w/acme/projects").body.items.filter((p) => p.default).map((p) => p.slug);
    expect(defaultOf()).toEqual(["default"]);
    expect(call<Workspace>("PATCH", "/api/w/acme", { default_project: "checkout-prod" }).body.default_project_id).toMatch(/^prj_/);
    expect(defaultOf()).toEqual(["checkout-prod"]);
    expect(call("PATCH", "/api/w/acme/p/checkout-prod", { archived: true, new_default: "checkout-staging" }).status).toBe(200);
    expect(defaultOf()).toEqual(["checkout-staging"]);

    const solo = client({ empty: true });
    expect(solo<{ error: string }>("PATCH", "/api/w/personal/p/default", { archived: true })).toEqual({
      status: 409,
      body: { error: "A workspace needs at least one project" },
    });
  });

  it("receives a first trace in an empty workspace a few seconds after a key is created", () => {
    vi.useFakeTimers();
    const call = client({ empty: true });
    expect(call<{ items: Workspace[] }>("GET", "/api/workspaces").body.items.map((w) => w.slug)).toEqual(["personal"]);
    const url = "/api/w/personal/p/default/invocations?since=1h&limit=1";
    expect(call<InvocationsResponse>("GET", url).body.items).toEqual([]);
    call("POST", "/api/w/personal/p/default/keys", { name: "First key" });
    vi.advanceTimersByTime(7_000);
    expect(call<InvocationsResponse>("GET", url).body.items).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("mock AWS API", () => {
  const W = "/api/w/acme/aws";

  it("groups functions by stack and traces a stack with a rule", () => {
    const call = client();
    const accounts = call<{ items: AwsAccount[] }>("GET", `${W}/accounts`).body.items;
    expect(accounts.map((a) => a.status)).toEqual(["connected", "connected"]);
    expect(accounts[0].counts).toMatchObject({ new: 2 });
    const staging = accounts[1];
    const groups = call<{ groups: FunctionGroup[] }>("GET", `${W}/accounts/${staging.id}/functions`).body.groups;
    expect(groups.map((g) => g.stack)).toEqual(["billing-dev", "checkout-staging", null]);
    expect(groups[1]).toMatchObject({ suggested_project: "checkout-staging", rule: null, counts: { traced: 0 } });

    const preview = call<DryRunResponse>("POST", `${W}/rules/dry-run`, { matcher: { stack: "checkout-staging" }, project: "checkout-staging" }).body;
    expect(preview).toMatchObject({ count: 2, summary: { trace: 2 } });

    const created = call<{ rule: Rule }>("POST", `${W}/rules`, { matcher: { stack: "billing-dev" }, new_project: { name: "billing-dev", slug: "billing-dev" } });
    expect(created.status).toBe(201);
    const after = call<{ groups: FunctionGroup[] }>("GET", `${W}/accounts/${staging.id}/functions`).body.groups;
    expect(after[0]).toMatchObject({ counts: { traced: 2 }, rule: { project: "billing-dev" } });
    expect(call<{ items: Rule[] }>("GET", `${W}/rules`).body.items.at(-1)?.project).toBe("billing-dev");
  });

  it("applies manual choices and walks the connect flow", () => {
    vi.useFakeTimers();
    const call = client();
    const fns = call<{ items: AwsFunction[] }>("GET", `${W}/functions?account=123456789012`).body.items;
    const traced = fns.find((f) => f.state === "traced" && f.source === "rule")!;
    const off = call<{ function: AwsFunction }>("PUT", `${W}/functions/${traced.account_id}/${traced.region}/${traced.name}`, { mode: "exclude" });
    expect(off.body.function).toMatchObject({ state: "opted_out", source: "manual" });

    const created = call<AwsAccount>("POST", `${W}/accounts`, { account_id: "111122223333", regions: ["eu-west-1"], stack_region: "eu-west-1" });
    expect(created.status).toBe(201);
    expect(call<VerifyResponse>("POST", `${W}/accounts/${created.body.id}/verify`).body.verified).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(call<VerifyResponse>("POST", `${W}/accounts/${created.body.id}/verify`).body).toMatchObject({ verified: true, account: { status: "connected" } });
    const fresh = call<{ items: AwsFunction[] }>("GET", `${W}/functions?account=111122223333`).body.items;
    expect(fresh.filter((f) => f.state === "traced")).toEqual([]);
    expect(call("DELETE", `${W}/accounts/${created.body.id}`).status).toBe(200);
    vi.useRealTimers();
  });

  it("can start empty", () => {
    const call = client({ empty: true });
    expect(call<{ items: unknown[] }>("GET", "/api/w/personal/aws/accounts").body.items).toEqual([]);
    expect(call<{ items: unknown[] }>("GET", "/api/w/personal/functions?since=7d").body.items).toEqual([]);
  });
});
