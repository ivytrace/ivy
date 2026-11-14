import type { Usage, WorkspaceLimits } from "../api/types.ts";
import type { MockUsage } from "./aws.ts";
import { NOW } from "./fixtures.ts";

/** The mock billing service (served by the mock API, as hosted's /billing would be). */
export const MOCK_BILLING_URL = "/api/mock-billing";

const FREE: WorkspaceLimits = { plan: "Free", monthly_trace_quota: 100_000, over_quota: "block", source: "workspace" };
const PRO: WorkspaceLimits = { plan: "Pro", monthly_trace_quota: 100_000, over_quota: "allow", source: "workspace" };
const UNLIMITED: WorkspaceLimits = { plan: "", monthly_trace_quota: null, over_quota: "allow", source: "unset" };

const FIXTURES: Record<MockUsage, { traces: number; limits: WorkspaceLimits }> = {
  free: { traces: 62_418, limits: FREE },
  near: { traces: 86_250, limits: FREE },
  over: { traces: 100_000, limits: FREE },
  paid: { traces: 2_481_904, limits: PRO },
  unlimited: { traces: 1_204_331, limits: UNLIMITED },
};

export function mockUsage(kind: MockUsage, workspace = "ten_mock"): Usage {
  const { traces, limits } = FIXTURES[kind] ?? FIXTURES.free;
  const now = new Date(NOW);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return {
    workspace,
    month: new Date(start).toISOString().slice(0, 7),
    period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    traces,
    limits,
    blocked: limits.over_quota === "block" && limits.monthly_trace_quota !== null && traces >= limits.monthly_trace_quota,
  };
}
