import { describe, expect, it, vi } from "vitest";
import { createMockHandler, handleMockRequest } from "./server";
import type { AwsAccount, AwsFunction, ErrorGroup, FunctionSummary, InvocationsResponse, Trace, VerifyResponse } from "../api/types";
import { describeSpan, getLogs, llmUsage } from "../spans/services";

const get = <T>(path: string) => {
  const res = handleMockRequest(new URL(path, "http://mock"));
  return { status: res.status, body: res.body as T };
};

describe("mock API", () => {
  it("serves functions, invocations with cursor pagination and filters", () => {
    const fns = get<{ items: FunctionSummary[] }>("/api/functions?since=7d").body.items;
    expect(fns.length).toBeGreaterThanOrEqual(4);

    const page1 = get<InvocationsResponse>("/api/invocations?since=7d&limit=10").body;
    expect(page1.items).toHaveLength(10);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = get<InvocationsResponse>(`/api/invocations?since=7d&limit=10&cursor=${page1.next_cursor}`).body;
    expect(page2.items[0].ts <= page1.items[9].ts).toBe(true);

    const errors = get<InvocationsResponse>("/api/invocations?since=7d&status=error&function=checkout-createOrder").body;
    expect(errors.items.every((i) => i.status === "error" && i.function === "checkout-createOrder")).toBe(true);

    const q = get<InvocationsResponse>("/api/invocations?since=7d&q=reading").body;
    expect(q.items.length).toBeGreaterThan(0);
  });

  it("serves a rich trace for an error group sample", () => {
    const groups = get<{ items: ErrorGroup[] }>("/api/errors?since=7d").body.items;
    const checkout = groups.find((g) => g.function === "checkout-createOrder")!;
    const trace = get<Trace>(`/api/traces/${checkout.sample_trace_id}`).body;
    const icons = trace.spans.map((s) => describeSpan(s).icon);
    expect(icons).toContain("dynamodb");
    expect(icons).toContain("external");
    expect(getLogs(trace.spans).length).toBeGreaterThan(0);
    expect(trace.spans[0].events.some((e) => e.name === "exception")).toBe(true);

    const ok = get<InvocationsResponse>("/api/invocations?since=7d&status=ok&function=checkout-createOrder").body.items[0];
    const okIcons = get<Trace>(`/api/traces/${ok.trace_id}`).body.spans.map((s) => describeSpan(s).icon);
    expect(okIcons).toEqual(expect.arrayContaining(["dynamodb", "s3", "sqs", "sns", "external"]));
  });

  it("serves an AI SDK trace: generateText with a tool call, then streamText", () => {
    const inv = get<InvocationsResponse>("/api/invocations?since=7d&status=ok&function=support-answerTicket").body.items[0];
    const spans = get<Trace>(`/api/traces/${inv.trace_id}`).body.spans;
    const names = spans.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["ai.generateText", "ai.generateText.doGenerate", "ai.toolCall", "ai.streamText.doStream", "DynamoDB.GetItem"]));
    expect(llmUsage(spans)).toMatchObject({ calls: 3, inputTokens: 1877, outputTokens: 103 });
    const tool = spans.find((s) => s.name === "ai.toolCall")!;
    expect(spans.find((s) => s.name === "DynamoDB.GetItem")!.parent_span_id).toBe(tool.span_id);
    expect(describeSpan(spans.find((s) => s.name === "ai.streamText.doStream")!).llm?.ttftMs).toBeGreaterThan(200);
  });

  it("returns 404 for unknown traces", () => {
    expect(get("/api/traces/nope").status).toBe(404);
  });
});

describe("mock AWS API", () => {
  it("lists accounts and functions, toggles tracing and walks the connect flow", () => {
    vi.useFakeTimers();
    const handle = createMockHandler();
    const call = <T>(method: string, path: string, body?: Record<string, unknown>) => {
      const res = handle(new URL(path, "http://mock"), { method, body });
      return { status: res.status, body: res.body as T };
    };

    const accounts = call<{ items: AwsAccount[] }>("GET", "/api/aws/accounts").body.items;
    expect(accounts.map((a) => a.status)).toEqual(["connected", "connected"]);
    expect(accounts[0].counts.total).toBeGreaterThan(5);

    const fns = call<{ items: AwsFunction[] }>("GET", `/api/aws/functions?account=${accounts[0].account_id}`).body.items;
    const traced = fns.find((f) => f.state === "traced")!;
    const off = call<{ function: AwsFunction }>("PUT", `/api/aws/functions/${traced.account_id}/${traced.region}/${traced.name}`, { tracing_enabled: false });
    expect(off.body.function).toMatchObject({ state: "opted_out", tracing_enabled: false });

    const created = call<AwsAccount>("POST", "/api/aws/accounts", { account_id: "111122223333", regions: ["eu-west-1"], stack_region: "eu-west-1" });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("pending");
    expect(call<VerifyResponse>("POST", `/api/aws/accounts/${created.body.id}/verify`).body.verified).toBe(false);
    vi.advanceTimersByTime(10_000);
    const verified = call<VerifyResponse>("POST", `/api/aws/accounts/${created.body.id}/verify`).body;
    expect(verified).toMatchObject({ verified: true, account: { status: "connected", syncing: true } });

    expect(call("DELETE", `/api/aws/accounts/${created.body.id}`).status).toBe(200);
    expect(call("GET", `/api/aws/accounts/${created.body.id}`).status).toBe(404);
    vi.useRealTimers();
  });

  it("can start empty", () => {
    const handle = createMockHandler({ empty: true });
    expect((handle(new URL("http://mock/api/aws/accounts")).body as { items: unknown[] }).items).toEqual([]);
    expect((handle(new URL("http://mock/api/functions?since=7d")).body as { items: unknown[] }).items).toEqual([]);
  });
});
