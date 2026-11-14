import type { ErrorGroup, Invocation, Trace } from "@ivy/spans";

export interface InvocationQuery {
  function?: string;
  status?: "ok" | "error";
  /** Free text: request ID, trace ID, error message or HTTP path (as `GET /api/invocations?q=`). */
  q?: string;
  /** Relative range like `15m`, `1h`, `24h`, `7d`. */
  since?: string;
  limit?: number;
}

export interface ErrorQuery {
  function?: string;
  since?: string;
}

/**
 * What the MCP tools read. The API implements it on top of its own route handlers, run in-process
 * with the request's tenant, so the tools see exactly what the HTTP API returns for that tenant.
 */
export interface IvyData {
  invocations(query: InvocationQuery): Promise<Invocation[]>;
  /** null when the trace does not exist (for this tenant). */
  trace(traceId: string): Promise<Trace | null>;
  errors(query: ErrorQuery): Promise<ErrorGroup[]>;
}
