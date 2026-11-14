import useSWR, { type SWRConfiguration } from "swr";
import { buildUrl, fetchJson, rangeParams, type QueryParams } from "./client";
import type {
  Config,
  ErrorGroup,
  FunctionSummary,
  InvocationsResponse,
  ListResponse,
  TimeRange,
  TimeseriesPoint,
  Trace,
} from "./types";

function useApi<T>(url: string | null, options?: SWRConfiguration<T>) {
  return useSWR<T>(url, (u: string) => fetchJson<T>(u), {
    revalidateOnFocus: false,
    keepPreviousData: true,
    ...options,
  });
}

export const useConfig = () => useApi<Config>(buildUrl("/config"), { revalidateIfStale: false });

export const useFunctions = (range: TimeRange) =>
  useApi<ListResponse<FunctionSummary>>(buildUrl("/functions", rangeParams(range)));

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
