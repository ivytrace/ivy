import useSWR, { type SWRConfiguration } from "swr";
import { buildUrl, fetchJson, rangeParams, type QueryParams } from "./client";
import type {
  AwsAccount,
  AwsFunction,
  AwsSetup,
  Config,
  ErrorGroup,
  FunctionSummary,
  InvocationsResponse,
  ListResponse,
  Since,
  TimeRange,
  TimeseriesPoint,
  Trace,
  Usage,
} from "./types";

function useApi<T>(url: string | null, options?: SWRConfiguration<T>) {
  return useSWR<T>(url, (u: string) => fetchJson<T>(u), {
    revalidateOnFocus: false,
    keepPreviousData: true,
    ...options,
  });
}

export const useConfig = () => useApi<Config>(buildUrl("/config"), { revalidateIfStale: false });

/** This month's traces and the workspace's limits (refreshed every minute, like the server's count). */
export const useUsage = () => useApi<Usage>(buildUrl("/usage"), { refreshInterval: 60_000 });

export const useFunctions = (range: TimeRange) =>
  useApi<ListResponse<FunctionSummary>>(buildUrl("/functions", rangeParams(range)));

const SINCE_MS: Record<Since, number> = { "15m": 15 * 60_000, "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

export function sparklineBucket(range: TimeRange): string {
  const span = "since" in range ? SINCE_MS[range.since] : Date.parse(range.to) - Date.parse(range.from);
  if (span <= 2 * 3_600_000) return "5m";
  if (span <= 2 * 86_400_000) return "1h";
  return "1d";
}

export const useTimeseries = (range: TimeRange, params: { function?: string; bucket?: string } = {}) =>
  useApi<ListResponse<TimeseriesPoint>>(
    buildUrl("/stats/timeseries", { ...rangeParams(range), ...params }),
  );

export interface InvocationFilters {
  function?: string;
  status?: "ok" | "error";
  q?: string;
  cursor?: string;
  limit?: number;
}

export const useInvocations = (range: TimeRange, filters: InvocationFilters) =>
  useApi<InvocationsResponse>(
    buildUrl("/invocations", { ...rangeParams(range), ...(filters as QueryParams) }),
  );

export const useErrors = (range: TimeRange, fn?: string) =>
  useApi<ListResponse<ErrorGroup>>(buildUrl("/errors", { ...rangeParams(range), function: fn }));

export const useTrace = (traceId: string | undefined) =>
  useApi<Trace>(traceId ? buildUrl(`/traces/${encodeURIComponent(traceId)}`) : null, {
    keepPreviousData: false,
    revalidateIfStale: false,
  });

export const useAwsSetup = () => useApi<AwsSetup>(buildUrl("/aws/setup"), { revalidateIfStale: false });

const busy = (a: AwsAccount) => a.syncing || a.status === "pending";

/** Polls while an account is syncing or waiting to be verified. */
export const useAwsAccounts = () =>
  useApi<ListResponse<AwsAccount>>(buildUrl("/aws/accounts"), {
    refreshInterval: (data) => (data?.items.some(busy) ? 3000 : 30_000),
  });

export const useAwsAccount = (id: string | undefined) =>
  useApi<AwsAccount>(id ? buildUrl(`/aws/accounts/${encodeURIComponent(id)}`) : null, {
    keepPreviousData: false,
    refreshInterval: (data) => (data && busy(data) ? 3000 : 30_000),
  });

export const useAwsFunctions = (accountId?: string, options: { refreshInterval?: number } = {}) =>
  useApi<ListResponse<AwsFunction>>(buildUrl("/aws/functions", { account: accountId }), options);
