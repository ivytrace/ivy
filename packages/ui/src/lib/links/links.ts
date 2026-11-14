/**
 * Dashboard URLs: `/w/:workspace/:project/<page>` (project `all` = every project of the workspace)
 * and `/w/:workspace/settings/<section>`. Pure functions, so redirects can be unit-tested.
 */

export const ALL_PROJECTS = "all";

export interface Scope {
  workspace: string;
  /** A project slug, or `all`. */
  project: string;
}

export type ProjectPage = "functions" | "invocations" | "errors";

const enc = encodeURIComponent;

export const projectBase = (s: Scope) => `/w/${enc(s.workspace)}/${enc(s.project)}`;

export const pageLink = (s: Scope, page: ProjectPage) => `${projectBase(s)}/${page}`;

export const traceLink = (s: Scope, traceId: string, invocationSpanId?: string) =>
  `${projectBase(s)}/traces/${traceId}${invocationSpanId ? `?invocation=${invocationSpanId}` : ""}`;

export const invocationsLink = (s: Scope, filters: { function?: string; status?: "ok" | "error"; q?: string } = {}) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const qs = params.toString();
  return `${pageLink(s, "invocations")}${qs ? `?${qs}` : ""}`;
};

export const errorsLink = (s: Scope, fn?: string) => `${pageLink(s, "errors")}${fn ? `?function=${enc(fn)}` : ""}`;

export type SettingsSection = "general" | "members" | "projects" | "aws" | "usage" | "alerts" | "digest" | "notifications";

export const settingsLink = (workspace: string, section: SettingsSection = "general") => `/w/${enc(workspace)}/settings/${section}`;

export const awsAccountsLink = (workspace: string) => settingsLink(workspace, "aws");

export const accountLink = (workspace: string, id: string) => `${awsAccountsLink(workspace)}/${enc(id)}`;

/** A project's alert settings (Slack). */
export const alertsLink = (workspace: string, project?: string) => `${settingsLink(workspace, "alerts")}${project ? `/${enc(project)}` : ""}`;

/** The workspace's usage and billing page (also where ingest's 429 message points). */
export const usageLink = (workspace: string) => settingsLink(workspace, "usage");

/** The workspace and project of a dashboard path; `project` is null on settings pages. */
export function parseScope(pathname: string): { workspace: string; project: string | null } | null {
  const m = /^\/w\/([^/]+)(?:\/([^/]+))?/.exec(pathname);
  if (!m) return null;
  const workspace = decodeURIComponent(m[1]);
  const project = m[2] && m[2] !== "settings" ? decodeURIComponent(m[2]) : null;
  return { workspace, project };
}

/** Where a path from before workspaces (`/functions`, `/traces/:id`, `/settings/aws/:id`, …) lives now. */
export function legacyTarget(pathname: string, scope: Scope): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return pageLink(scope, "functions");
  const page = /^\/(functions|invocations|errors)$/.exec(path);
  if (page) return pageLink(scope, page[1] as ProjectPage);
  const trace = /^\/traces\/([^/]+)$/.exec(path);
  if (trace) return `${projectBase(scope)}/traces/${trace[1]}`;
  if (path === "/settings") return settingsLink(scope.workspace);
  if (path === "/settings/aws") return awsAccountsLink(scope.workspace);
  if (path === "/settings/usage") return usageLink(scope.workspace);
  const account = /^\/settings\/aws\/([^/]+)$/.exec(path);
  if (account) return `${awsAccountsLink(scope.workspace)}/${account[1]}`;
  return null;
}

interface Pickable {
  slug: string;
}

/**
 * The scope to open when the URL doesn't say: the last-used workspace (if the user still has it,
 * else the first), and in it the last-used project (if it still exists and isn't archived), else
 * the default project, else the first active one.
 */
export function pickWorkspace<W extends Pickable>(workspaces: W[], last: Partial<Scope> | null): W | null {
  return workspaces.find((w) => w.slug === last?.workspace) ?? workspaces[0] ?? null;
}

export function pickProject<P extends Pickable & { archived: boolean; default: boolean }>(
  projects: P[],
  workspace: string,
  last: Partial<Scope> | null,
): string {
  const active = projects.filter((p) => !p.archived);
  if (last?.workspace === workspace && last.project) {
    if (last.project === ALL_PROJECTS || active.some((p) => p.slug === last.project)) return last.project;
  }
  return (active.find((p) => p.default) ?? active[0])?.slug ?? ALL_PROJECTS;
}

const LAST_KEY = "ivy.lastScope";

export function readLastScope(): Partial<Scope> | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? (JSON.parse(raw) as Partial<Scope>) : null;
  } catch {
    return null;
  }
}

export function writeLastScope(scope: Partial<Scope>) {
  try {
    const prev = readLastScope();
    const next = { ...(prev?.workspace === scope.workspace ? prev : {}), ...scope };
    localStorage.setItem(LAST_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: nothing to remember
  }
}
