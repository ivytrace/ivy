import type { ErrorGroup, Invocation, QueryResult, Trace } from "@ivy/spans";

/** A workspace (tenant) the caller is a member of. */
export interface Workspace {
  id: string;
  name: string;
  /** Short handle derived from the name, unique among the caller's workspaces. */
  slug: string;
}

export interface InvocationQuery {
  /** Project slug or ID within the workspace; omit for all of its projects. */
  project?: string;
  function?: string;
  status?: "ok" | "error" | "in_progress";
  /** Free text (request ID, trace ID, error message or HTTP path) plus `key=value` span attribute terms (as `GET /api/invocations?q=`). */
  q?: string;
  /** Relative range like `15m`, `1h`, `24h`, `7d`. Ignored when `from` is set. */
  since?: string;
  /** Absolute range (ISO 8601). */
  from?: string;
  to?: string;
  limit?: number;
}

export interface ErrorQuery {
  /** Project slug or ID within the workspace; omit for all of its projects. */
  project?: string;
  function?: string;
  since?: string;
}

export interface SqlQuery {
  /** One ClickHouse SELECT over the Query page's views (`invocations`, `spans`, `logs`). */
  sql: string;
  /** Project slug or ID within the workspace; omit for all of its projects. */
  project?: string;
  since?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * What the MCP tools read. Every read is for exactly one workspace; the tools fan out over the
 * caller's workspaces themselves (see workspaces/fan-out.ts). The API implements this on top of its
 * own route handlers, run in-process with that workspace's tenant and shard.
 */
export interface IvyData<W extends Workspace = Workspace> {
  /** The caller's workspaces (just `default` with auth off or in single-tenant mode). */
  workspaces(): Promise<W[]>;
  invocations(workspace: W, query: InvocationQuery): Promise<Invocation[]>;
  /** null when the trace is not in this workspace. */
  trace(workspace: W, traceId: string, project?: string): Promise<Trace | null>;
  errors(workspace: W, query: ErrorQuery): Promise<ErrorGroup[]>;
  /** Runs SQL as the workspace's read-only query user (docs/implementation/query.md). */
  query(workspace: W, query: SqlQuery): Promise<QueryResult>;
}
