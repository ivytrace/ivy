import type {
  ErrorGroup,
  FunctionSummary,
  Invocation,
  InvocationsResponse,
  TimeseriesPoint,
} from "../api/types.ts";
import { createAwsMock, type MockOptions } from "./aws.ts";
import { buildTrace, INVOCATIONS, NOW, type MockInvocation } from "./fixtures.ts";

export type { MockOptions };

export interface MockResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

export interface MockRequest {
  method?: string;
  body?: Record<string, unknown>;
}

const SINCE_MS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 3600_000,
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
};

function range(params: URLSearchParams): [number, number] {
  const from = params.get("from");
  const to = params.get("to");
  if (from && to) return [new Date(from).getTime(), new Date(to).getTime()];
  const since = SINCE_MS[params.get("since") ?? "24h"] ?? SINCE_MS["24h"];
  return [NOW - since, NOW];
}

function inRange(params: URLSearchParams): MockInvocation[] {
  const [from, to] = range(params);
  const fn = params.get("function");
  return INVOCATIONS.filter((i) => {
    const t = new Date(i.ts).getTime();
    return t >= from && t <= to && (!fn || i.function === fn);
  });
}

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;

const round = (n: number) => Math.round(n * 10) / 10;

const strip = ({ seed: _seed, ...rest }: MockInvocation): Invocation => rest;

function functions(params: URLSearchParams): FunctionSummary[] {
  const groups = new Map<string, MockInvocation[]>();
  for (const inv of inRange(params)) {
    const list = groups.get(inv.function) ?? [];
    list.push(inv);
    groups.set(inv.function, list);
  }
  return [...groups.entries()].map(([name, list]) => {
    const durations = list.map((i) => i.duration_ms).sort((a, b) => a - b);
    const errors = list.filter((i) => i.status === "error").length;
    return {
      name,
      region: list[0].region,
      invocations: list.length,
      errors,
      error_rate: Math.round((errors / list.length) * 10000) / 10000,
      cold_starts: list.filter((i) => i.cold_start).length,
      avg_ms: round(durations.reduce((a, b) => a + b, 0) / durations.length),
      p50_ms: percentile(durations, 0.5),
      p95_ms: percentile(durations, 0.95),
      p99_ms: percentile(durations, 0.99),
      last_invoked: list[0].ts,
    };
  });
}

function invocations(params: URLSearchParams): InvocationsResponse {
  const status = params.get("status");
  const q = params.get("q")?.toLowerCase();
  const limit = Math.min(Number(params.get("limit") ?? 50) || 50, 500);
  const offset = Number(params.get("cursor") ? atob(params.get("cursor")!) : 0);
  const matches = inRange(params).filter(
    (i) =>
      (!status || i.status === status) &&
      (!q ||
        [i.request_id, i.trace_id, i.error_message, i.http_path].some((v) =>
          v?.toLowerCase().includes(q),
        )),
  );
  const page = matches.slice(offset, offset + limit);
  const next = offset + limit < matches.length ? btoa(String(offset + limit)) : null;
  return { items: page.map(strip), next_cursor: next };
}

function errors(params: URLSearchParams): ErrorGroup[] {
  const groups = new Map<string, MockInvocation[]>();
  for (const inv of inRange(params).filter((i) => i.status === "error")) {
    const key = `${inv.function}|${inv.error_type}|${inv.error_message}`;
    const list = groups.get(key) ?? [];
    list.push(inv);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({
      fingerprint: Math.abs([...key].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0))
        .toString(16)
        .padStart(8, "0"),
      function: list[0].function,
      error_type: list[0].error_type ?? "Error",
      error_message: list[0].error_message ?? "",
      count: list.length,
      first_seen: list[list.length - 1].ts,
      last_seen: list[0].ts,
      sample_trace_id: list[0].trace_id,
      failure_kind: list[0].failure_kind,
    }))
    .sort((a, b) => b.count - a.count);
}

const BUCKET_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3600_000,
  "1d": 86_400_000,
};

function timeseries(params: URLSearchParams): TimeseriesPoint[] {
  const [from, to] = range(params);
  const span = to - from;
  const bucket =
    BUCKET_MS[params.get("bucket") ?? ""] ??
    (span <= 3600_000 ? 60_000 : span <= 86_400_000 ? 3600_000 : 86_400_000);
  const start = Math.floor(from / bucket) * bucket;
  const buckets = new Map<number, number[]>();
  const errs = new Map<number, number>();
  for (const inv of inRange(params)) {
    const b = Math.floor(new Date(inv.ts).getTime() / bucket) * bucket;
    buckets.set(b, [...(buckets.get(b) ?? []), inv.duration_ms]);
    if (inv.status === "error") errs.set(b, (errs.get(b) ?? 0) + 1);
  }
  const out: TimeseriesPoint[] = [];
  for (let b = start; b <= to; b += bucket) {
    const d = (buckets.get(b) ?? []).sort((x, y) => x - y);
    out.push({
      ts: new Date(b).toISOString(),
      invocations: d.length,
      errors: errs.get(b) ?? 0,
      p95_ms: percentile(d, 0.95),
    });
  }
  return out;
}

/** A stateful mock API (AWS accounts can be connected, toggled and deleted while the dev server runs). */
export function createMockHandler(options: MockOptions = {}) {
  const aws = createAwsMock(options);
  return (url: URL, req: MockRequest = {}): MockResponse => {
    const method = req.method ?? "GET";
    if (url.pathname.startsWith("/api/aws/")) {
      return aws.handle(method, url.pathname, url.searchParams, req.body ?? {}) ?? { status: 404, body: { error: "not found" } };
    }
    if (method !== "GET") return { status: 405, body: { error: "Method not allowed" } };
    if (options.empty && url.pathname !== "/api/health" && url.pathname !== "/api/config") {
      return { status: url.pathname.startsWith("/api/traces/") ? 404 : 200, body: url.pathname === "/api/invocations" ? { items: [], next_cursor: null } : { items: [] } };
    }
    return handleMockRequest(url);
  };
}

export function handleMockRequest(url: URL): MockResponse {
  const p = url.searchParams;
  const path = url.pathname;
  if (path === "/api/health") return { status: 200, body: { ok: true, clickhouse: true } };
  if (path === "/api/config") return { status: 200, body: { version: "0.1.0-mock", auth: { enabled: false } } };
  if (path === "/api/functions") return { status: 200, body: { items: functions(p) } };
  if (path === "/api/invocations") return { status: 200, body: invocations(p) };
  if (path === "/api/errors") return { status: 200, body: { items: errors(p) } };
  if (path === "/api/stats/timeseries") return { status: 200, body: { items: timeseries(p) } };
  const trace = path.match(/^\/api\/traces\/([^/]+)$/);
  if (trace) {
    const inv = INVOCATIONS.find((i) => i.trace_id === trace[1]);
    if (!inv) return { status: 404, body: { error: "trace not found" } };
    return { status: 200, body: { trace_id: inv.trace_id, spans: buildTrace(inv) } };
  }
  return { status: 404, body: { error: "not found" } };
}
