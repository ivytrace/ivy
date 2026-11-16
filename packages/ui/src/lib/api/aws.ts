import { mutate } from "swr";
import { sendJson } from "./client";
import { wsPath } from "./hooks";
import type { AwsAccount, DryRunResponse, Project, Rule, RuleMatcher, TracingResponse, VerifyResponse } from "./types";

const aws = (ws: string) => `/api${wsPath(ws)}/aws`;
const accountUrl = (ws: string, id: string) => `${aws(ws)}/accounts/${encodeURIComponent(id)}`;

/** Revalidates every cached AWS response (and project lists, which rules can change). */
export const refreshAws = () => mutate((key) => typeof key === "string" && (key.includes("/aws/") || key.endsWith("/projects")));

export interface NewAccount {
  account_id: string;
  name?: string;
  regions: string[];
  all_regions: boolean;
  stack_region: string;
}

export const createAwsAccount = (ws: string, body: NewAccount) => sendJson<AwsAccount>("POST", `${aws(ws)}/accounts`, body);

export const verifyAwsAccount = (ws: string, id: string) => sendJson<VerifyResponse>("POST", `${accountUrl(ws, id)}/verify`);

export const syncAwsAccount = (ws: string, id: string) => sendJson<{ started: boolean }>("POST", `${accountUrl(ws, id)}/sync`);

export const updateAwsAccount = (
  ws: string,
  id: string,
  body: Partial<Pick<AwsAccount, "name" | "regions" | "all_regions" | "throttle_metrics">> & { reviewed?: boolean },
) => sendJson<AwsAccount>("PATCH", accountUrl(ws, id), body);

export const deleteAwsAccount = (ws: string, id: string, detach: boolean) =>
  sendJson<{ deleted: boolean; detach_errors: string[] }>("DELETE", `${accountUrl(ws, id)}?detach=${detach}`);

export type ManualChoice = { mode: "trace"; project: string } | { mode: "exclude" } | { mode: "rules" };

export const setFunctionChoice = (ws: string, fn: { account_id: string; region: string; name: string }, choice: ManualChoice) =>
  sendJson<TracingResponse>("PUT", `${aws(ws)}/functions/${fn.account_id}/${fn.region}/${encodeURIComponent(fn.name)}`, choice);

/** Force install over another tracer's exec wrapper (`true`, also to retry after it was set back), or hand it back (`false`). */
export const setFunctionForce = (ws: string, fn: { account_id: string; region: string; name: string }, force: boolean) =>
  sendJson<TracingResponse>("POST", `${aws(ws)}/functions/${fn.account_id}/${fn.region}/${encodeURIComponent(fn.name)}/force`, { force });

export const setFunctionsChoice = (ws: string, functions: { account_id: string; region: string; name: string }[], choice: ManualChoice) =>
  sendJson<{ updated: number }>("POST", `${aws(ws)}/functions/bulk`, { functions, ...choice });

export interface NewRule {
  matcher: RuleMatcher;
  project?: string;
  new_project?: { name: string };
  enabled?: boolean;
}

export const createRule = (ws: string, body: NewRule) => sendJson<{ rule: Rule; project: Project | null }>("POST", `${aws(ws)}/rules`, body);

export const updateRule = (ws: string, id: string, body: Partial<Pick<NewRule, "matcher" | "project" | "enabled">>) =>
  sendJson<Rule>("PATCH", `${aws(ws)}/rules/${encodeURIComponent(id)}`, body);

export const deleteRule = (ws: string, id: string) => sendJson<{ deleted: boolean }>("DELETE", `${aws(ws)}/rules/${encodeURIComponent(id)}`);

export const reorderRules = (ws: string, order: string[]) => sendJson<{ items: Rule[] }>("PUT", `${aws(ws)}/rules/order`, { order });

export const dryRun = (ws: string, matcher: RuleMatcher, project?: string) =>
  sendJson<DryRunResponse>("POST", `${aws(ws)}/rules/dry-run`, { matcher, project });
