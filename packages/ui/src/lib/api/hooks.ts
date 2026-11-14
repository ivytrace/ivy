import useSWR, { type SWRConfiguration } from "swr";
import { ALL_PROJECTS, type Scope } from "../links/links";
import { useScope, useWorkspace } from "../links/use-scope";
import { buildUrl, fetchJson, rangeParams, type QueryParams } from "./client";
import type {
  AlertsResponse,
  ApiKey,
  AwsAccount,
  AwsFunction,
  AwsSetup,
  Config,
  DigestInfo,
  ErrorGroup,
  FunctionGroup,
  FunctionSummary,
  Invitation,
  InvocationsResponse,
  ListResponse,
  Member,
  NotificationsResponse,
  Project,
  Rule,
  Since,
  TimeRange,
  TimeseriesPoint,
  Trace,
  Usage,
  Workspace,
} from "./types";

function useApi<T>(url: string | null, options?: SWRConfiguration<T>) {
  return useSWR<T>(url, (u: string) => fetchJson<T>(u), {
    revalidateOnFocus: false,
    keepPreviousData: true,
    ...options,
  });
}

const enc = encodeURIComponent;

/** API path prefix of a workspace: `/w/<slug>`. */
export const wsPath = (workspace: string) => `/w/${enc(workspace)}`;

/** API path prefix of a scope: `/w/<ws>/p/<project>`, or `/w/<ws>` for all projects. */
export const scopePath = (s: Scope) => (s.project === ALL_PROJECTS ? wsPath(s.workspace) : `${wsPath(s.workspace)}/p/${enc(s.project)}`);

export const useConfig = () => useApi<Config>(buildUrl("/config"), { revalidateIfStale: false });

/** Workspace switching, member management etc. exist only in multi-workspace mode. */
export function useMultiWorkspace() {
  return useConfig().data?.workspaces?.multi === true;
}

export const useWorkspaces = () => useApi<ListResponse<Workspace>>(buildUrl("/workspaces"));

/** This month's traces and limits of a workspace (all its projects), refreshed every minute like the server's count. */
export const useUsage = (workspace: string | null | undefined) =>
  useApi<Usage>(workspace ? buildUrl(`${wsPath(workspace)}/usage`) : null, { refreshInterval: 60_000, keepPreviousData: false });

export const useWorkspaceInfo = (workspace: string | undefined) =>
  useApi<Workspace>(workspace ? buildUrl(wsPath(workspace)) : null, { keepPreviousData: false });

export const useProjects = (workspace: string | undefined, archived = false) =>
  useApi<ListResponse<Project>>(workspace ? buildUrl(`${wsPath(workspace)}/projects`, { archived: archived ? 1 : undefined }) : null, {
    keepPreviousData: false,
  });

export const useKeys = (workspace: string, project: string | null) =>
  useApi<ListResponse<ApiKey>>(project ? buildUrl(`${wsPath(workspace)}/p/${enc(project)}/keys`) : null);

export const useMembers = (workspace: string, enabled = true) =>
  useApi<ListResponse<Member>>(enabled ? buildUrl(`${wsPath(workspace)}/members`) : null);

export const useInvitations = (workspace: string, enabled = true) =>
  useApi<ListResponse<Invitation>>(enabled ? buildUrl(`${wsPath(workspace)}/invitations`) : null);

/** Function overview of the current scope (all projects included when the project is `all`). */
export function useFunctions(range: TimeRange) {
  const scope = useScope();
  return useApi<ListResponse<FunctionSummary>>(buildUrl(`${scopePath(scope)}/functions`, rangeParams(range)));
}

/** Workspace-wide function overview (used by onboarding). */
export function useWorkspaceFunctions(workspace: string, range: TimeRange) {
  return useApi<ListResponse<FunctionSummary>>(buildUrl(`${wsPath(workspace)}/functions`, rangeParams(range)));
}

const SINCE_MS: Record<Since, number> = { "15m": 15 * 60_000, "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

export function sparklineBucket(range: TimeRange): string {
  const span = "since" in range ? SINCE_MS[range.since] : Date.parse(range.to) - Date.parse(range.from);
  if (span <= 2 * 3_600_000) return "5m";
  if (span <= 2 * 86_400_000) return "1h";
  return "1d";
}

/**
 * Totals over time in the current scope (summed over every project under `all`). `project` overrides
 * the URL's project (sparklines on the all-projects page, where a row belongs to one project).
 */
export function useTimeseries(range: TimeRange, params: { function?: string; bucket?: string; project?: string | null } = {}) {
  const scope = useScope();
  const { project, ...rest } = params;
  const p = project ?? scope.project;
  return useApi<ListResponse<TimeseriesPoint>>(
    buildUrl(`${scopePath({ workspace: scope.workspace, project: p })}/stats/timeseries`, { ...rangeParams(range), ...rest }),
  );
}

export interface InvocationFilters {
  function?: string;
  status?: "ok" | "error" | "in_progress";
  q?: string;
  cursor?: string;
  limit?: number;
}

/** Invocations of the current scope; under `all`, of every project (items then carry `project`). */
export function useInvocations(range: TimeRange, filters: InvocationFilters, options?: SWRConfiguration<InvocationsResponse>) {
  const scope = useScope();
  return useApi<InvocationsResponse>(buildUrl(`${scopePath(scope)}/invocations`, { ...rangeParams(range), ...(filters as QueryParams) }), options);
}

/**
 * The project a trace belongs to, for a trace opened under `all`: its invocation from the workspace-wide
 * list (`q` matches trace IDs exactly), over a range longer than any retention. null when there's none.
 */
export function useTraceProject(workspace: string, traceId: string | undefined, range: TimeRange) {
  const { data, error } = useApi<InvocationsResponse>(
    traceId ? buildUrl(`${wsPath(workspace)}/invocations`, { ...rangeParams(range), q: traceId, limit: 1 }) : null,
    { keepPreviousData: false, revalidateIfStale: false },
  );
  return { project: data ? (data.items[0]?.project ?? null) : undefined, error };
}

export function useErrors(range: TimeRange, fn?: string) {
  const scope = useScope();
  return useApi<ListResponse<ErrorGroup>>(buildUrl(`${scopePath(scope)}/errors`, { ...rangeParams(range), function: fn }));
}

export function useTrace(traceId: string | undefined) {
  const scope = useScope();
  return useApi<Trace>(traceId && scope.project !== ALL_PROJECTS ? buildUrl(`${scopePath(scope)}/traces/${enc(traceId)}`) : null, {
    keepPreviousData: false,
    revalidateIfStale: false,
  });
}

export function useAwsSetup() {
  const ws = useWorkspace();
  return useApi<AwsSetup>(buildUrl(`${wsPath(ws)}/aws/setup`), { revalidateIfStale: false });
}

const busy = (a: AwsAccount) => a.syncing || a.status === "pending";

/** Polls while an account is syncing or waiting to be verified. */
export function useAwsAccounts() {
  const ws = useWorkspace();
  return useApi<ListResponse<AwsAccount>>(buildUrl(`${wsPath(ws)}/aws/accounts`), {
    refreshInterval: (data) => (data?.items.some(busy) ? 3000 : 30_000),
  });
}

export function useAwsAccount(id: string | undefined) {
  const ws = useWorkspace();
  return useApi<AwsAccount>(id ? buildUrl(`${wsPath(ws)}/aws/accounts/${enc(id)}`) : null, {
    keepPreviousData: false,
    refreshInterval: (data) => (data && busy(data) ? 3000 : 30_000),
  });
}

export function useAwsAccountFunctions(id: string | undefined, options: { refreshInterval?: number } = {}) {
  const ws = useWorkspace();
  return useApi<{ groups: FunctionGroup[] }>(id ? buildUrl(`${wsPath(ws)}/aws/accounts/${enc(id)}/functions`) : null, options);
}

export function useAwsFunctions(params: { account?: string; project?: string } = {}, options: { refreshInterval?: number } = {}) {
  const ws = useWorkspace();
  return useApi<ListResponse<AwsFunction>>(buildUrl(`${wsPath(ws)}/aws/functions`, params), options);
}

export function useRules() {
  const ws = useWorkspace();
  return useApi<ListResponse<Rule>>(buildUrl(`${wsPath(ws)}/aws/rules`));
}

export const useAlerts = (workspace: string, project: string | null) =>
  useApi<AlertsResponse>(project ? buildUrl(`${wsPath(workspace)}/p/${enc(project)}/alerts`) : null, { keepPreviousData: false });

export const useDigest = (workspace: string) => useApi<DigestInfo>(buildUrl(`${wsPath(workspace)}/digest`));

export const useNotifications = () => useApi<NotificationsResponse>(buildUrl("/me/notifications"));
