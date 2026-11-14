import { useEffect } from "react";
import { Navigate, Outlet, useLocation, useParams } from "react-router";

import { ErrorState, LoadingState } from "@/components/common/states";
import { useProjects, useWorkspaces } from "@/lib/api/hooks";
import { ALL_PROJECTS, legacyTarget, parseScope, pageLink, pickProject, pickWorkspace, readLastScope, writeLastScope } from "@/lib/links/links";
import NotFound from "@/routes/not-found";

/**
 * Paths from before workspaces (`/`, `/functions`, `/traces/:id`, `/settings/aws/:id`, …): sends them
 * to the same page in the last-used workspace and project, keeping the query string and hash.
 */
export function LegacyRedirect() {
  const location = useLocation();
  const last = readLastScope();
  const workspaces = useWorkspaces();
  const workspace = workspaces.data ? pickWorkspace(workspaces.data.items, last) : null;
  const projects = useProjects(workspace?.slug);

  if (workspaces.error) return <ErrorState error={workspaces.error} onRetry={() => void workspaces.mutate()} />;
  if (workspaces.data && !workspace) return <NotFound />;
  if (projects.error) return <ErrorState error={projects.error} onRetry={() => void projects.mutate()} />;
  if (!workspace || !projects.data) return <LoadingState />;

  const project = pickProject(projects.data.items, workspace.slug, readLastScope(workspace.slug));
  const target = legacyTarget(location.pathname, { workspace: workspace.slug, project });
  if (!target) return <NotFound />;
  return <Navigate to={`${target}${location.search}${location.hash}`} replace />;
}

/** `/w/:workspace`: the last-used project of that workspace, else All projects. */
export function WorkspaceIndex() {
  const { workspace = "" } = useParams();
  const projects = useProjects(workspace);
  if (projects.error) return <ErrorState error={projects.error} onRetry={() => void projects.mutate()} />;
  if (!projects.data) return <LoadingState />;
  return <Navigate to={pageLink({ workspace, project: pickProject(projects.data.items, workspace, readLastScope(workspace)) }, "functions")} replace />;
}

/** Project pages: 404 for a project the workspace doesn't have. */
export function ProjectLayout() {
  const { workspace = "", project = "" } = useParams();
  const projects = useProjects(workspace, true);
  if (projects.error) return <ErrorState error={projects.error} onRetry={() => void projects.mutate()} />;
  if (project !== ALL_PROJECTS && projects.data && !projects.data.items.some((p) => p.slug === project)) return <NotFound />;
  return <Outlet />;
}

/** Remembers the workspace and project the user last looked at. */
export function ScopeTracker() {
  const { pathname } = useLocation();
  useEffect(() => {
    const scope = parseScope(pathname);
    if (!scope) return;
    writeLastScope(scope.project ? { workspace: scope.workspace, project: scope.project } : { workspace: scope.workspace });
  }, [pathname]);
  return null;
}
