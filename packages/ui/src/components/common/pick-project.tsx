import { Link } from "react-router";
import { Layers } from "lucide-react";

import { useProjects } from "@/lib/api/hooks";
import { pageLink, type ProjectPage } from "@/lib/links/links";

/** Shown on pages that need one project (invocations, traces) while "All projects" is selected. */
export function PickProject({ workspace, page }: { workspace: string; page: ProjectPage }) {
  const { data } = useProjects(workspace);
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed p-10 text-center">
      <Layers className="size-6 text-muted-foreground" />
      <div>
        <div className="font-medium">Pick a project</div>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">This page shows one project at a time.</p>
      </div>
      <div className="flex max-w-xl flex-wrap justify-center gap-2">
        {data?.items.map((p) => (
          <Link key={p.id} to={pageLink({ workspace, project: p.slug }, page)} className="rounded-full border px-3 py-1 text-sm hover:bg-accent">
            {p.name}
          </Link>
        ))}
      </div>
    </div>
  );
}
