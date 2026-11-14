export const traceLink = (traceId: string, invocationSpanId?: string) =>
  `/traces/${traceId}${invocationSpanId ? `?invocation=${invocationSpanId}` : ""}`;

export const invocationsLink = (filters: { function?: string; status?: "ok" | "error"; q?: string } = {}) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const qs = params.toString();
  return `/invocations${qs ? `?${qs}` : ""}`;
};
