const key = (workspace: string) => `ivy.lastTraceProject.${workspace}`;

/** The project last chosen for tracing functions in this workspace (this browser only). */
export function readLastTraceProject(workspace: string): string | null {
  try {
    return localStorage.getItem(key(workspace));
  } catch {
    return null;
  }
}

export function rememberTraceProject(workspace: string, project: string) {
  try {
    localStorage.setItem(key(workspace), project);
  } catch {
    // Private mode or blocked storage: nothing to remember.
  }
}

/** The first candidate slug that names one of `projects`, else "" (the user picks). */
export function preselectProject(projects: { slug: string }[], ...candidates: (string | null | undefined)[]): string {
  return candidates.find((c) => c && projects.some((p) => p.slug === c)) ?? "";
}
