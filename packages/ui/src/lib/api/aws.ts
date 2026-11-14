import { mutate } from "swr";
import { sendJson } from "./client";
import type { AwsAccount, TracingResponse, VerifyResponse } from "./types";

const accountUrl = (id: string) => `/api/aws/accounts/${encodeURIComponent(id)}`;

/** Revalidates every cached /api/aws/* response. */
export const refreshAws = () => mutate((key) => typeof key === "string" && key.startsWith("/api/aws/"));

export interface NewAccount {
  account_id: string;
  name?: string;
  regions: string[];
  all_regions: boolean;
  stack_region: string;
}

export const createAwsAccount = (body: NewAccount) => sendJson<AwsAccount>("POST", "/api/aws/accounts", body);

export const verifyAwsAccount = (id: string) => sendJson<VerifyResponse>("POST", `${accountUrl(id)}/verify`);

export const syncAwsAccount = (id: string) => sendJson<{ started: boolean }>("POST", `${accountUrl(id)}/sync`);

export const updateAwsAccount = (id: string, body: Partial<Pick<AwsAccount, "name" | "regions" | "all_regions">>) =>
  sendJson<AwsAccount>("PATCH", accountUrl(id), body);

export const deleteAwsAccount = (id: string, detach: boolean) =>
  sendJson<{ deleted: boolean; detach_errors: string[] }>("DELETE", `${accountUrl(id)}?detach=${detach}`);

export const setFunctionTracing = (accountId: string, region: string, name: string, enabled: boolean) =>
  sendJson<TracingResponse>(
    "PUT",
    `/api/aws/functions/${accountId}/${region}/${encodeURIComponent(name)}`,
    { tracing_enabled: enabled },
  );
