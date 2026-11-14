import { describe, expect, it } from "vitest";
import { handleMockRequest } from "./server";
import type { ErrorGroup, FunctionSummary, InvocationsResponse, Trace } from "../api/types";
import { describeSpan, getLogs } from "../spans/services";

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

  it("returns 404 for unknown traces", () => {
    expect(get("/api/traces/nope").status).toBe(404);
  });
});
