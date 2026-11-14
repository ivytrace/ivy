import { createContext, createElement, useContext, type ReactNode } from "react";
import { useLocation } from "react-router";
import { ALL_PROJECTS, parseScope, readLastScope, type Scope } from "./links";

type RouteScope = { workspace: string; project: string | null };

const ScopeOverride = createContext<RouteScope | null>(null);

/** Pages outside `/w/...` (the setup wizard) set their workspace and project here for the API hooks. */
export function ScopeProvider({ scope, children }: { scope: RouteScope; children: ReactNode }) {
  return createElement(ScopeOverride.Provider, { value: scope }, children);
}

/** The workspace (and project, on project pages) of the current URL. */
export function useRouteScope(): RouteScope | null {
  const override = useContext(ScopeOverride);
  const parsed = parseScope(useLocation().pathname);
  return override ?? parsed;
}

/** The workspace slug of the current URL (pages under `/w/:workspace`). */
export function useWorkspace(): string {
  return useRouteScope()?.workspace ?? "default";
}

/** The workspace and project of the current URL (project pages); `all` outside a project. */
export function useScope(): Scope {
  const scope = useRouteScope();
  return { workspace: scope?.workspace ?? "default", project: scope?.project ?? ALL_PROJECTS };
}

/**
 * The scope the header and ⌘K link into: the URL's, and on settings pages the workspace's last-used
 * project, else All projects. Null outside a workspace.
 */
export function useNavScope(): Scope | null {
  const route = useRouteScope();
  if (!route) return null;
  return { workspace: route.workspace, project: route.project ?? readLastScope(route.workspace)?.project ?? ALL_PROJECTS };
}
