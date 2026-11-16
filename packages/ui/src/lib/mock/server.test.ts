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
import { describeSpan, droppedSpans, getLogs, inProgressState, llmUsage } from "../spans/services";

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
    expect(projects).toEqual(expect.arrayContaining(["checkout-prod", "checkout-staging", "billing-api-prod", "billing-api-staging"]));
    expect(projects).not.toContain("legacy-reports");
    expect(call<{ items: unknown[] }>("GET", "/api/w/acme/members").body.items.length).toBeGreaterThan(1);
    expect(call<{ items: unknown[] }>("GET", "/api/w/acme/invitations").body.items).toHaveLength(1);
    expect(call("GET", "/api/w/nope/projects").status).toBe(404);
  });

  it("serves project-scoped data with cursor pagination and filters", () => {
    const call = client();
    const fns = call<{ items: FunctionSummary[] }>("GET", `${P}/functions?since=7d`).body.items;
    expect(fns.map((f) => f.name).sort()).toEqual(["checkout-createOrder", "checkout-importOrders", "orders-processQueue"]);

    const page1 = call<InvocationsResponse>("GET", `${P}/invocations?since=7d&limit=10`).body;
    expect(page1.items).toHaveLength(10);
    const page2 = call<InvocationsResponse>("GET", `${P}/invocations?since=7d&limit=10&cursor=${page1.next_cursor}`).body;
    expect(page2.items[0].ts <= page1.items[9].ts).toBe(true);
    const errors = call<InvocationsResponse>("GET", `${P}/invocations?since=7d&status=error&function=checkout-createOrder`).body;
    expect(errors.items.every((i) => i.status === "error" && i.function === "checkout-createOrder")).toBe(true);
    const [one] = page1.items;
    const byAttribute = call<InvocationsResponse>("GET", `${P}/invocations?since=7d&q=${encodeURIComponent(`faas.invocation_id=${one.request_id}`)}`).body;
    expect(byAttribute.items.map((i) => i.span_id)).toEqual([one.span_id]);

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

  it("groups errors by message template, with variants, and lists one group's invocations", () => {
    const call = client();
    const billing = "/api/w/acme/p/billing-api-prod";
    const groups = call<{ items: ErrorGroup[] }>("GET", `${billing}/errors?since=7d`).body.items;
    const uploads = groups.filter((g) => g.error_template === "Upload not found for ID: {path}");
    expect(uploads).toHaveLength(1);
    const [group] = uploads;
    expect(group.variants).toBeGreaterThan(1);
    expect(group.top_messages.length).toBe(Math.min(group.variants, 5));
    expect(group.top_messages.reduce((n, m) => n + m.count, 0)).toBeLessThanOrEqual(group.count);
    expect(group.top_messages.every((m) => m.message.startsWith("Upload not found for ID: "))).toBe(true);

    const listed = call<InvocationsResponse>("GET", `${billing}/invocations?since=7d&limit=500&group=${group.fingerprint}`).body.items;
    expect(listed.length).toBe(group.count);
    expect(listed.every((i) => i.status === "error" && i.error_message?.startsWith("Upload not found"))).toBe(true);
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

  it("serves in-progress invocations, refreshes them by ID and adds new ones while live", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const call = client();
      const running = call<InvocationsResponse>("GET", `${P}/invocations?since=24h&status=in_progress`).body.items;
      expect(running.map((i) => i.function).sort()).toEqual(["checkout-importOrders", "orders-processQueue"]);
      const [importRow, stalled] = [running.find((i) => i.function === "checkout-importOrders")!, running.find((i) => i.function === "orders-processQueue")!];
      expect(inProgressState(Date.parse(importRow.deadline!))).toBe("running");
      expect(inProgressState(Date.parse(stalled.deadline!))).toBe("no_completion");
      const root = call<Trace>("GET", `${P}/traces/${importRow.trace_id}`).body.spans[0];
      expect(root.attributes["ivy.in_progress"]).toBe("true");
      expect(root.status_code).toBe("UNSET");
      const fns = call<{ items: FunctionSummary[] }>("GET", `${P}/functions?since=1h`).body.items;
      const imports = call<InvocationsResponse>("GET", `${P}/invocations?since=1h&function=checkout-importOrders`).body.items;
      expect(fns.find((f) => f.name === "checkout-importOrders")?.invocations).toBe(imports.filter((i) => i.status !== "in_progress").length);
      expect(imports.some((i) => i.status === "in_progress")).toBe(true);

      const from = new Date(Date.now() - 1000).toISOString();
      expect(call<InvocationsResponse>("GET", `${P}/invocations?from=${from}`).body.items).toHaveLength(0);
      vi.setSystemTime(Date.now() + 25_000);
      const newer = call<InvocationsResponse>("GET", `${P}/invocations?from=${from}&limit=100`).body.items;
      expect(newer.length).toBeGreaterThan(0);
      const refreshed = call<InvocationsResponse>("GET", `${P}/invocations?since=15m&ids=${importRow.span_id},${stalled.span_id}`).body.items;
      expect(refreshed.find((i) => i.span_id === importRow.span_id)?.status).toBe("ok");
      expect(refreshed.find((i) => i.span_id === stalled.span_id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves an import worker trace with summary spans and omitted spans", () => {
    const call = client();
    const latest = call<InvocationsResponse>("GET", `${P}/invocations?since=1h&function=checkout-importOrders&status=ok`).body.items[0];
    expect(latest.trace_id).toBe("ca11ab1e00000000000000000000a1b2");
    const spans = call<Trace>("GET", `${P}/traces/${latest.trace_id}`).body.spans;
    const root = spans.find((s) => describeSpan(s).isInvocation)!;
    expect(droppedSpans(root.attributes)).toEqual({ count: 37, reason: "span limit" });
    const summary = spans.find((s) => s.name === "DynamoDB.PutItem × 1,184")!;
    expect(describeSpan(summary).collapsed).toMatchObject({ count: 1184, errors: 1, kept: 9 });
    expect(Date.parse(summary.end)).toBeLessThanOrEqual(Date.parse(root.end));
    expect(spans.filter((s) => s.status_code === "ERROR").map((s) => s.name)).toEqual(["DynamoDB.PutItem"]);
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

  it("has no default project: new workspaces start empty, and any project can be archived, the last one too", () => {
    const call = client();
    expect(call<Workspace>("GET", "/api/w/acme").body).not.toHaveProperty("default_project_id");
    expect(call<{ items: Project[] }>("GET", "/api/w/acme/projects").body.items.some((p) => "default" in p)).toBe(false);

    const solo = client({ empty: true });
    expect(solo<{ items: Project[] }>("GET", "/api/w/personal/projects").body.items).toEqual([]);
    expect(solo<Project>("POST", "/api/w/personal/projects", { name: "Checkout" }).status).toBe(201);
    expect(solo<Project>("PATCH", "/api/w/personal/p/checkout", { archived: true }).body.archived).toBe(true);
    expect(solo<{ items: Project[] }>("GET", "/api/w/personal/projects").body.items).toEqual([]);
  });

  it("needs a project for every rule and manual choice; ivy:trace=true alone needs a project", () => {
    const call = client();
    const fn = (name: string) => call<{ items: AwsFunction[] }>("GET", "/api/w/acme/aws/functions").body.items.find((f) => f.name === name)!;
    expect(fn("ops-healthcheck")).toMatchObject({ state: "needs_project", reason: "Tagged ivy:trace=true without ivy:project", project: null });
    expect(call<{ items: AwsAccount[] }>("GET", "/api/w/acme/aws/accounts").body.items[0]).not.toHaveProperty("default_project");
    expect(call("POST", "/api/w/acme/aws/rules", { matcher: { name: "*" } }).status).toBe(400);
    expect(call("PUT", "/api/w/acme/aws/functions/123456789012/eu-west-1/ops-healthcheck", { mode: "trace" }).status).toBe(400);
    expect(call("PUT", "/api/w/acme/aws/functions/123456789012/eu-west-1/ops-healthcheck", { mode: "trace", project: "checkout-prod" }).status).toBe(200);
    expect(fn("ops-healthcheck")).toMatchObject({ state: "traced", project: "checkout-prod", source: "tag" });
  });

  it("receives a first trace in an empty workspace a few seconds after a key is created", () => {
    vi.useFakeTimers();
    const call = client({ empty: true });
    expect(call<{ items: Workspace[] }>("GET", "/api/workspaces").body.items.map((w) => w.slug)).toEqual(["personal"]);
    call("POST", "/api/w/personal/projects", { name: "First" });
    const url = "/api/w/personal/p/first/invocations?since=1h&limit=1";
    expect(call<InvocationsResponse>("GET", url).body.items).toEqual([]);
    call("POST", "/api/w/personal/p/first/keys", { name: "First key" });
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

  it("force-installs over another tracer's wrapper, flags a re-applied wrapper, and hands it back on exclude", () => {
    const call = client();
    const fn = (name: string) => call<{ items: AwsFunction[] }>("GET", `${W}/functions`).body.items.find((f) => f.name === name)!;
    const url = (name: string) => `${W}/functions/123456789012/eu-west-1/${name}`;
    expect(fn("checkout-capturePayment")).toMatchObject({ state: "conflict", conflict: "wrapper", wrapper: "/opt/lumigo_wrapper", tracer: "Lumigo", force: false });
    expect(fn("search-suggest")).toMatchObject({ state: "conflict", tracer: null });

    const forced = call<{ function: AwsFunction }>("POST", `${url("checkout-capturePayment")}/force`, { force: true });
    expect(forced.body.function).toMatchObject({ state: "traced", conflict: null, wrapper: "/opt/lumigo_wrapper", force: true });
    expect(call("POST", `${url("checkout-capturePayment")}/force`, {}).status).toBe(400);

    expect(fn("orders-notifyCustomer")).toMatchObject({ state: "conflict", conflict: "reapplied", force: true });
    expect(call<{ function: AwsFunction }>("POST", `${url("orders-notifyCustomer")}/force`, { force: true }).body.function).toMatchObject({ state: "traced" });

    const off = call<{ function: AwsFunction }>("PUT", url("checkout-capturePayment"), { mode: "exclude" });
    expect(off.body.function).toMatchObject({ state: "opted_out", force: false });
  });

  it("can start empty", () => {
    const call = client({ empty: true });
    expect(call<{ items: unknown[] }>("GET", "/api/w/personal/aws/accounts").body.items).toEqual([]);
    expect(call<{ items: unknown[] }>("GET", "/api/w/personal/functions?since=7d").body.items).toEqual([]);
  });
});
