// A direct import: vite.config.ts loads this file with Node, which resolves no `.js` -> `.ts` imports.
import { errorTemplate } from "@ivy/spans/error-template";
import type { ErrorGroup, FunctionSummary, Invocation, InvocationsResponse, TimeseriesPoint } from "../api/types.ts";
import { createAlertsMock } from "./alerts.ts";
import { createAwsMock, type MockOptions } from "./aws.ts";
import { buildTrace, INVOCATIONS, type MockInvocation } from "./fixtures.ts";
import { liveRows, progressRows } from "./progress.ts";
import { mockUsage, MOCK_BILLING_URL } from "./usage.ts";
import { newInvitation, newKey, newProject, newWorkspace, seedWorkspaces, slugFrom, slugOk, type MockWorkspace } from "./workspaces.ts";
import { THROTTLED_MESSAGE, THROTTLES, type MockThrottle } from "./throttles.ts";

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

/** Which project of the `acme` workspace each fixture function sends to. */
export const PROJECT_OF: Record<string, string> = {
  "checkout-createOrder": "checkout-prod",
  "orders-processQueue": "checkout-prod",
  "checkout-importOrders": "checkout-prod",
  "auth-getProfile": "billing-api-prod",
  "reports-nightlyExport": "billing-api-staging",
  "support-answerTicket": "support-api-prod",
  "email-sendReceipt": "billing-api-prod",
};

/**
 * The project an invocation was sent to: its function's, except that a quarter of `checkout-createOrder`
 * runs come from `checkout-staging`, so "All projects" shows one function name in two projects.
 */
export function projectOfInvocation(inv: MockInvocation): string {
  if (inv.function === "checkout-createOrder" && inv.seed % 4 === 0) return "checkout-staging";
  return PROJECT_OF[inv.function] ?? "checkout-prod";
}

/** Seconds after a rule or key is created in an empty workspace until the mock "receives" a first trace. */
const FIRST_TRACE_MS = 6_000;

type Row = MockInvocation & { project: string };

function range(params: URLSearchParams): [number, number] {
  const from = params.get("from");
  const to = params.get("to");
  if (from) return [new Date(from).getTime(), to ? new Date(to).getTime() : Date.now()];
  const since = SINCE_MS[params.get("since") ?? "24h"] ?? SINCE_MS["24h"];
  const now = Date.now();
  return [now - since, now];
}

function inRange(pool: Row[], params: URLSearchParams): Row[] {
  const [from, to] = range(params);
  const fn = params.get("function");
  return pool.filter((i) => {
    const t = new Date(i.ts).getTime();
    return t >= from && t <= to && (!fn || i.function === fn);
  });
}

type ThrottleRow = MockThrottle & { project: string };

function throttlesInRange(pool: ThrottleRow[], params: URLSearchParams): ThrottleRow[] {
  const [from, to] = range(params);
  const fn = params.get("function");
  return pool.filter((t) => t.minute >= from && t.minute < to && (!fn || t.function === fn));
}

/** Aggregates count finished invocations only, like the API (in-progress records are not in `invocations`). */
const finished = (rows: Row[]) => rows.filter((r) => r.status !== "in_progress");

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const round = (n: number) => Math.round(n * 10) / 10;
const strip = ({ seed: _seed, project: _project, ...rest }: Row): Invocation => rest;

function functions(pool: Row[], throttles: ThrottleRow[], params: URLSearchParams, byProject: boolean, ids: Map<string, string>): FunctionSummary[] {
  const groups = new Map<string, Row[]>();
  for (const inv of finished(inRange(pool, params))) {
    const key = `${byProject ? inv.project : ""}|${inv.function}`;
    groups.set(key, [...(groups.get(key) ?? []), inv]);
  }
  const throttled = new Map<string, number>();
  for (const t of throttlesInRange(throttles, params)) {
    const key = `${byProject ? t.project : ""}|${t.function}`;
    throttled.set(key, (throttled.get(key) ?? 0) + t.throttles);
  }
  return [...groups.entries()].map(([key, list]) => {
    const durations = list.map((i) => i.duration_ms).sort((a, b) => a - b);
    const errors = list.filter((i) => i.status === "error").length;
    return {
      name: list[0].function,
      region: list[0].region,
      ...(byProject ? { project_id: ids.get(list[0].project) ?? list[0].project, project: list[0].project } : {}),
      invocations: list.length,
      errors,
      error_rate: Math.round((errors / list.length) * 10000) / 10000,
      cold_starts: list.filter((i) => i.cold_start).length,
      avg_ms: round(durations.reduce((a, b) => a + b, 0) / durations.length),
      p50_ms: percentile(durations, 0.5),
      p95_ms: percentile(durations, 0.95),
      p99_ms: percentile(durations, 0.99),
      last_invoked: list[0].ts,
      throttles: throttled.get(key) ?? 0,
    };
  });
}

/** `ids` (slug → project ID) for workspace-wide lists, whose items carry `project_id` and `project`. */
function invocations(pool: Row[], params: URLSearchParams, ids?: Map<string, string>): InvocationsResponse {
  const status = params.get("status");
  const q = params.get("q")?.toLowerCase();
  const limit = Math.min(Number(params.get("limit") ?? 50) || 50, 500);
  const offset = Number(params.get("cursor") ? atob(params.get("cursor")!) : 0);
  const only = params.get("ids") ? new Set(params.get("ids")!.split(",")) : null;
  const group = params.get("group");
  const found = inRange(pool, params).filter(
    (i) =>
      (!only || only.has(i.span_id)) &&
      (!group || (i.status === "error" && fingerprint(groupKey(i, false)) === group)) &&
      (!status || i.status === status) &&
      (!q || [i.request_id, i.trace_id, i.error_message, i.http_path].some((v) => v?.toLowerCase().includes(q))),
  );
  const page = found.slice(offset, offset + limit);
  const next = offset + limit < found.length ? btoa(String(offset + limit)) : null;
  return {
    items: page.map((row) => (ids ? { ...strip(row), project_id: ids.get(row.project) ?? row.project, project: row.project } : strip(row))),
    next_cursor: next,
  };
}

/** Mock grouping: function, error type and message template (the mock has no stacks, so no code location). */
const groupKey = (i: Row, byProject: boolean) =>
  `${byProject ? i.project : ""}|${i.function}|${i.error_type}|${errorTemplate(i.error_message ?? "", i.error_type ?? "")}`;

/** Project-independent, so the invocations list (one project) finds a group listed under all projects. */
const fingerprint = (key: string) =>
  Math.abs([...key.slice(key.indexOf("|") + 1)].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0))
    .toString(16)
    .padStart(8, "0");

function errors(pool: Row[], throttles: ThrottleRow[], params: URLSearchParams, byProject: boolean, ids: Map<string, string>): ErrorGroup[] {
  const groups = new Map<string, Row[]>();
  for (const inv of finished(inRange(pool, params)).filter((i) => i.status === "error")) {
    const key = groupKey(inv, byProject);
    groups.set(key, [...(groups.get(key) ?? []), inv]);
  }
  return [...groups.entries()]
    .map(([key, list]): ErrorGroup => {
      const messages = new Map<string, Row[]>();
      for (const inv of list) messages.set(inv.error_message ?? "", [...(messages.get(inv.error_message ?? "") ?? []), inv]);
      return {
        fingerprint: fingerprint(key),
        function: list[0].function,
        ...(byProject ? { project_id: ids.get(list[0].project) ?? list[0].project, project: list[0].project } : {}),
        error_type: list[0].error_type ?? "Error",
        error_message: list[0].error_message ?? "",
        error_template: key.slice(key.indexOf("|", key.indexOf("|", key.indexOf("|") + 1) + 1) + 1),
        count: list.length,
        variants: messages.size,
        top_messages: [...messages.entries()]
          .map(([message, rows]) => ({ message, count: rows.length, sample_trace_id: rows[0].trace_id, last_seen: rows[0].ts }))
          .sort((a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen))
          .slice(0, 5),
        first_seen: list[list.length - 1].ts,
        last_seen: list[0].ts,
        sample_trace_id: list[0].trace_id,
        kind: "error" as const,
        failure_kind: list[0].failure_kind,
      };
    })
    .concat(throttleGroups(throttles, params, byProject, ids))
    .sort((a, b) => b.count - a.count);
}

function throttleGroups(pool: ThrottleRow[], params: URLSearchParams, byProject: boolean, ids: Map<string, string>): ErrorGroup[] {
  const byFn = new Map<string, ThrottleRow[]>();
  for (const t of throttlesInRange(pool, params)) {
    const key = `${byProject ? t.project : ""}|${t.region}:${t.function}`;
    byFn.set(key, [...(byFn.get(key) ?? []), t]);
  }
  return [...byFn.values()].map((list) => ({
    fingerprint: `throttled:${list[0].region}:${list[0].function}`,
    function: list[0].function,
    ...(byProject ? { project_id: ids.get(list[0].project) ?? list[0].project, project: list[0].project } : {}),
    error_type: "Throttled",
    error_message: THROTTLED_MESSAGE,
    error_template: THROTTLED_MESSAGE,
    count: list.reduce((n, t) => n + t.throttles, 0),
    variants: 1,
    top_messages: [],
    first_seen: new Date(Math.min(...list.map((t) => t.minute))).toISOString(),
    last_seen: new Date(Math.max(...list.map((t) => t.minute))).toISOString(),
    sample_trace_id: null,
    kind: "throttle",
    failure_kind: null,
  }));
}

const BUCKET_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3600_000, "1d": 86_400_000 };

function timeseries(pool: Row[], throttles: ThrottleRow[], params: URLSearchParams): TimeseriesPoint[] {
  const [from, to] = range(params);
  const span = to - from;
  const bucket = BUCKET_MS[params.get("bucket") ?? ""] ?? (span <= 3600_000 ? 60_000 : span <= 86_400_000 ? 3600_000 : 86_400_000);
  const start = Math.floor(from / bucket) * bucket;
  const buckets = new Map<number, number[]>();
  const errs = new Map<number, number>();
  for (const inv of finished(inRange(pool, params))) {
    const b = Math.floor(new Date(inv.ts).getTime() / bucket) * bucket;
    buckets.set(b, [...(buckets.get(b) ?? []), inv.duration_ms]);
    if (inv.status === "error") errs.set(b, (errs.get(b) ?? 0) + 1);
  }
  const throttled = new Map<number, number>();
  for (const t of throttlesInRange(throttles, params)) {
    const b = Math.floor(t.minute / bucket) * bucket;
    throttled.set(b, (throttled.get(b) ?? 0) + t.throttles);
  }
  const out: TimeseriesPoint[] = [];
  for (let b = start; b <= to; b += bucket) {
    const d = (buckets.get(b) ?? []).sort((x, y) => x - y);
    out.push({
      ts: new Date(b).toISOString(),
      invocations: d.length,
      errors: errs.get(b) ?? 0,
      p95_ms: percentile(d, 0.95),
      throttles: throttled.get(b) ?? 0,
    });
  }
  return out;
}

const json = (status: number, body: unknown): MockResponse => ({ status, body });
const notFound = (what = "Not found") => json(404, { error: what });

/**
 * A stateful mock of the whole API: workspaces, projects, members, invitations, keys, AWS accounts,
 * rules and span data (for the `acme` workspace; other workspaces start empty and "receive" a first
 * trace a few seconds after a rule or ingest key is created).
 */
export function createMockHandler(options: MockOptions = {}) {
  const workspaces = seedWorkspaces(!!options.empty);
  const aws = new Map<string, ReturnType<typeof createAwsMock>>();
  const live = new Map<string, Row[]>();
  const alerts = createAlertsMock({ configured: !options.noAlerts });
  const created = Date.now();
  /** Set by the first live poll (`from` without `to`): from then on new invocations keep arriving. */
  let liveStart: number | null = null;

  const awsOf = (ws: MockWorkspace) => {
    let mock = aws.get(ws.id);
    if (!mock) {
      mock = createAwsMock(options, () => ws.projects, () => ws.slug);
      aws.set(ws.id, mock);
    }
    return mock;
  };

  const seeded = (ws: MockWorkspace) => !options.empty && ws.slug === "acme";

  const poolOf = (ws: MockWorkspace, project: string | null): Row[] => {
    const now = Date.now();
    const rows: Row[] = seeded(ws)
      ? [...liveRows(liveStart, now), ...progressRows(created, liveStart, now), ...INVOCATIONS]
          .map((i) => ({ ...i, project: projectOfInvocation(i) }))
          .sort((a, b) => b.ts.localeCompare(a.ts))
      : (live.get(ws.id) ?? []);
    return project ? rows.filter((r) => r.project === project) : rows;
  };

  const throttlePoolOf = (ws: MockWorkspace, project: string | null): ThrottleRow[] => {
    const rows = seeded(ws) ? THROTTLES.map((t) => ({ ...t, project: PROJECT_OF[t.function] ?? "checkout-prod" })) : [];
    return project ? rows.filter((r) => r.project === project) : rows;
  };

  /** Pretends the first invocation of a function in `project` arrives a few seconds from now. */
  const scheduleFirstTrace = (ws: MockWorkspace, project: string) => {
    if (seeded(ws) || (live.get(ws.id)?.length ?? 0) > 0) return;
    setTimeout(() => {
      const sample = INVOCATIONS.find((i) => i.status === "ok" && i.function === "checkout-createOrder") ?? INVOCATIONS[0];
      live.set(ws.id, [...(live.get(ws.id) ?? []), { ...sample, ts: new Date().toISOString(), project }]);
    }, FIRST_TRACE_MS);
  };

  const find = (ref: string) => workspaces.find((w) => w.slug === ref || w.id === ref);
  const projectOf = (ws: MockWorkspace, ref: string) => ws.projects.find((p) => p.slug === ref || p.id === ref);
  const present = ({ projects, members: _m, invitations: _i, keys: _k, ...w }: MockWorkspace) => ({
    ...w,
    default_project_id: projects.find((p) => p.default)?.id ?? "",
  });
  const makeDefault = (ws: MockWorkspace, id: string) => {
    for (const x of ws.projects) x.default = x.id === id;
  };
  const ids = (ws: MockWorkspace) => new Map(ws.projects.map((p) => [p.slug, p.id]));

  function data(ws: MockWorkspace, project: string | null, rest: string, params: URLSearchParams): MockResponse | null {
    if (rest === "/invocations" && params.get("from") && !params.get("to")) liveStart ??= Date.now();
    const pool = poolOf(ws, project);
    const throttles = throttlePoolOf(ws, project);
    const all = project === null;
    if (rest === "/functions") return json(200, { items: functions(pool, throttles, params, all, ids(ws)) });
    if (rest === "/errors") return json(200, { items: errors(pool, throttles, params, all, ids(ws)) });
    if (rest === "/invocations") return json(200, invocations(pool, params, all ? ids(ws) : undefined));
    if (rest === "/stats/timeseries") {
      // Workspace-wide, `project` narrows to one project (a function name used in several projects).
      const only = all && params.get("project");
      if (!only) return json(200, { items: timeseries(pool, throttles, params) });
      const p = projectOf(ws, only);
      if (!p) return notFound("Project not found");
      return json(200, { items: timeseries(poolOf(ws, p.slug), throttlePoolOf(ws, p.slug), params) });
    }
    if (all) return null;
    const trace = rest.match(/^\/traces\/([^/]+)$/);
    if (trace) {
      const inv = pool.find((i) => i.trace_id === trace[1]);
      return inv ? json(200, { trace_id: inv.trace_id, spans: buildTrace(inv) }) : notFound("Trace not found");
    }
    return null;
  }

  function projectRoutes(ws: MockWorkspace, ref: string, rest: string, method: string, params: URLSearchParams, body: Record<string, unknown>): MockResponse {
    const p = projectOf(ws, ref);
    if (!p) return notFound("Project not found");
    if (rest === "" && method === "GET") return json(200, p);
    if (rest === "" && method === "PATCH") {
      if (typeof body.name === "string" && body.name.trim()) p.name = body.name.trim();
      if (typeof body.slug === "string" && body.slug && body.slug !== p.slug) {
        if (!slugOk(body.slug)) return json(400, { error: "Invalid slug" });
        if (ws.projects.some((x) => x.slug === body.slug)) return json(409, { error: `A project with slug "${body.slug}" already exists in this workspace` });
        for (const k of ws.keys) if (k.project === p.slug) k.project = body.slug;
        p.slug = body.slug;
      }
      if (typeof body.archived === "boolean") {
        if (body.archived && !p.archived) {
          const others = ws.projects.filter((x) => !x.archived && x.id !== p.id);
          if (!others.length) return json(409, { error: "A workspace needs at least one project" });
          if (p.default) {
            const ref = body.new_default;
            const next = ref ? others.find((x) => x.id === ref || x.slug === ref) : others[0];
            if (!next) return json(400, { error: `new_default: unknown project ${String(ref)}` });
            makeDefault(ws, next.id);
          }
        }
        p.archived = body.archived;
      }
      return json(200, p);
    }
    const alertRes = rest.startsWith("/alerts") ? alerts.projectRoutes(ws, p.slug, rest, method, body) : null;
    if (alertRes) return json(alertRes.status, alertRes.body);
    if (rest === "/keys" && method === "GET") {
      return json(200, { items: ws.keys.filter((k) => k.project === p.slug && !k.revoked_at).map(({ project: _p, ...k }) => k) });
    }
    if (rest === "/keys" && method === "POST") {
      const { record, key } = newKey(p.slug, typeof body.name === "string" && body.name ? body.name : "Ingest key");
      ws.keys.push(record);
      scheduleFirstTrace(ws, p.slug);
      const { project: _p, ...k } = record;
      return json(201, { ...k, key, endpoint: "https://ingest.example.com" });
    }
    const key = rest.match(/^\/keys\/([^/]+)$/);
    if (key && method === "DELETE") {
      const k = ws.keys.find((x) => x.id === key[1] && x.project === p.slug);
      if (!k) return notFound("Key not found");
      k.revoked_at = new Date().toISOString();
      const { project: _p, ...out } = k;
      return json(200, out);
    }
    if (method !== "GET") return json(405, { error: "Method not allowed" });
    return data(ws, p.slug, rest, params) ?? notFound();
  }

  function workspaceRoutes(ws: MockWorkspace, rest: string, method: string, params: URLSearchParams, body: Record<string, unknown>): MockResponse {
    if (rest === "" && method === "GET") return json(200, present(ws));
    if (rest === "" && method === "PATCH") {
      if (typeof body.name === "string" && body.name.trim()) ws.name = body.name.trim();
      if (typeof body.slug === "string" && body.slug !== ws.slug) {
        if (!slugOk(body.slug)) return json(400, { error: "Invalid slug" });
        if (workspaces.some((w) => w.slug === body.slug)) return json(409, { error: `The workspace slug "${body.slug}" is taken` });
        ws.slug = body.slug;
      }
      if (body.default_project !== undefined) {
        const next = ws.projects.find((x) => !x.archived && (x.id === body.default_project || x.slug === body.default_project));
        if (!next) return json(400, { error: `default_project: unknown project ${String(body.default_project)}` });
        makeDefault(ws, next.id);
      }
      return json(200, present(ws));
    }
    if (rest === "" && method === "DELETE") {
      if (params.get("confirm") !== ws.slug) return json(400, { error: `Type the workspace slug (${ws.slug}) to confirm` });
      if (awsOf(ws).hasAccounts()) return json(409, { error: "Disconnect this workspace's AWS accounts first" });
      workspaces.splice(workspaces.indexOf(ws), 1);
      return json(200, { deleted: true });
    }
    if (rest === "/members" && method === "GET") return json(200, { items: ws.members });
    if (rest.startsWith("/digest")) {
      const sevenDays = new URLSearchParams({ since: "7d" });
      const res = alerts.workspaceRoutes(ws, rest, method, body, () => errors(poolOf(ws, null), throttlePoolOf(ws, null), sevenDays, true, ids(ws)));
      if (res) return json(res.status, res.body);
    }
    if (rest === "/usage" && method === "GET") return json(200, mockUsage(options.usage ?? "free", ws.id));
    const member = rest.match(/^\/members\/([^/]+)$/);
    if (member) {
      const m = ws.members.find((x) => x.sub === decodeURIComponent(member[1]));
      if (!m) return notFound("Member not found");
      const owners = ws.members.filter((x) => x.role === "owner").length;
      if (method === "PATCH") {
        if (m.role === "owner" && body.role === "member" && owners === 1) return json(409, { error: "The last owner can't become a member" });
        m.role = body.role === "owner" ? "owner" : "member";
        return json(200, m);
      }
      if (method === "DELETE") {
        if (m.role === "owner" && owners === 1) return json(409, { error: "The last owner can't leave" });
        ws.members.splice(ws.members.indexOf(m), 1);
        if (m.you) workspaces.splice(workspaces.indexOf(ws), 1);
        return json(200, { removed: true });
      }
    }
    if (rest === "/invitations" && method === "GET") {
      return json(200, { items: ws.invitations.filter((i) => i.status === "pending").map(({ token: _t, ...i }) => i) });
    }
    if (rest === "/invitations" && method === "POST") {
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "email must be an email address" });
      if (ws.members.some((m) => m.email === email)) return json(409, { error: `${email} is already a member` });
      const inv = newInvitation(email, body.role === "owner" ? "owner" : "member");
      ws.invitations.push(inv);
      const { token, ...out } = inv;
      return json(201, { invitation: out, url: `${"http://localhost:5173"}/invite/${token}`, email_sent: false, email_error: null });
    }
    const inv = rest.match(/^\/invitations\/([^/]+)$/);
    if (inv && method === "DELETE") {
      const i = ws.invitations.find((x) => x.id === inv[1]);
      if (!i) return notFound("Invitation not found");
      i.status = "revoked";
      const { token: _t, ...out } = i;
      return json(200, out);
    }
    if (rest === "/projects" && method === "GET") {
      return json(200, { items: ws.projects.filter((p) => params.get("archived") === "1" || !p.archived) });
    }
    if (rest === "/projects" && method === "POST") {
      const name = String(body.name ?? "").trim();
      if (!name) return json(400, { error: "name must be a non-empty string" });
      const slug = slugFrom(name, (s) => ["all", "settings"].includes(s) || ws.projects.some((p) => p.slug === s));
      const p = newProject(slug, name);
      ws.projects.push(p);
      return json(201, p);
    }
    const prj = rest.match(/^\/p\/([^/]+)(\/.*)?$/);
    if (prj) return projectRoutes(ws, decodeURIComponent(prj[1]), prj[2] ?? "", method, params, body);
    if (rest.startsWith("/aws/")) {
      if (rest === "/aws/rules" && method === "POST") {
        let projectId = ws.projects.find((p) => !p.archived && (p.slug === body.project || p.id === body.project))?.id;
        let created = null;
        const np = body.new_project as { name?: string; slug?: string } | undefined;
        if (np) {
          const res = workspaceRoutes(ws, "/projects", "POST", params, np as Record<string, unknown>);
          if (res.status !== 201) return res;
          created = res.body as { id: string };
          projectId = created.id;
        }
        projectId ??= ws.projects.find((p) => p.default)!.id;
        const rule = awsOf(ws).addRule((body.matcher ?? {}) as Record<string, unknown>, projectId, body.enabled !== false);
        const project = ws.projects.find((p) => p.id === projectId)!;
        scheduleFirstTrace(ws, project.slug);
        return json(201, { rule, project });
      }
      if (rest === "/aws/functions/bulk" && body.mode === "trace") {
        const project = ws.projects.find((p) => p.slug === body.project) ?? ws.projects.find((p) => p.default)!;
        scheduleFirstTrace(ws, project.slug);
      }
      return awsOf(ws).handle(method, rest.slice(4), params, body) ?? notFound();
    }
    if (method !== "GET") return json(405, { error: "Method not allowed" });
    return data(ws, null, rest, params) ?? notFound();
  }

  return (url: URL, req: MockRequest = {}): MockResponse => {
    const method = req.method ?? "GET";
    const body = req.body ?? {};
    const path = url.pathname;
    const params = url.searchParams;
    if (path === "/api/health") return json(200, { ok: true, clickhouse: true });
    if (path === "/api/config") {
      return json(200, {
        version: "0.1.0-mock",
        auth: { enabled: false },
        workspaces: { multi: true },
        email: { enabled: false },
        aws: { quick_create: !options.noTemplate },
        alerts: alerts.config,
        ...(options.noBilling ? {} : { billing: { url: MOCK_BILLING_URL } }),
      });
    }
    if (path.startsWith(`${MOCK_BILLING_URL}/`) && method === "POST") {
      // Stands in for a billing service: checkout returns to the usage page with ?checkout=success.
      const ws = workspaces.find((w) => w.id === body.workspace || w.slug === body.workspace);
      if (!ws) return json(403, { error: "You are not a member of this workspace" });
      if (ws.role !== "owner") return json(403, { error: "Only workspace owners can change billing" });
      const action = path.slice(MOCK_BILLING_URL.length + 1);
      const usagePage = `/w/${ws.slug}/settings/usage`;
      if (action === "checkout") return json(200, { url: `${usagePage}?checkout=success` });
      if (action === "portal") return json(200, { url: usagePage });
    }
    if (path === "/api/workspaces" && method === "GET") return json(200, { items: workspaces.map(present) });
    if (path === "/api/me/notifications") {
      const res = alerts.notifications(workspaces, method, body);
      return json(res.status, res.body);
    }
    if (path === "/api/workspaces" && method === "POST") {
      const name = String(body.name ?? "").trim();
      if (!name) return json(400, { error: "name must be a non-empty string" });
      const slug = slugFrom(name, (s) => workspaces.some((w) => w.slug === s), "workspace");
      const ws = newWorkspace(name, slug, "owner");
      workspaces.push(ws);
      return json(201, present(ws));
    }
    const invite = path.match(/^\/api\/invitations\/([^/]+)(\/accept)?$/);
    if (invite) {
      const ws = workspaces.find((w) => w.invitations.some((i) => i.token === invite[1]));
      const inv = ws?.invitations.find((i) => i.token === invite[1]);
      if (!ws || !inv) return notFound("This invitation link is not valid");
      if (!invite[2]) {
        return json(200, { workspace: { slug: ws.slug, name: ws.name }, email: inv.email, role: inv.role, status: inv.status, invited_by: inv.invited_by, expires_at: inv.expires_at });
      }
      if (inv.status !== "pending") return json(410, { error: "This invitation has already been used" });
      inv.status = "accepted";
      inv.accepted_at = new Date().toISOString();
      return json(200, { accepted: true, workspace: present(ws) });
    }
    const w = path.match(/^\/api\/w\/([^/]+)(\/.*)?$/);
    if (w) {
      const ws = find(decodeURIComponent(w[1]));
      if (!ws) return notFound("Workspace not found");
      return workspaceRoutes(ws, w[2] ?? "", method, params, body);
    }
    if (path === "/api/aws/template.yaml") return { status: 200, contentType: "text/yaml", body: "AWSTemplateFormatVersion: 2010-09-09\nResources: {}\n" };
    return notFound();
  };
}
