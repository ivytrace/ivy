import { useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { Check, ChevronsUpDown, Layers, Plus, Settings } from "lucide-react";

import { NameDialog } from "@/components/workspaces/name-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMultiWorkspace, useProjects, useWorkspaces } from "@/lib/api/hooks";
import { createProject, createWorkspace, refreshWorkspace } from "@/lib/api/workspaces";
import { ALL_PROJECTS, pageLink, settingsLink, switchProjectLink } from "@/lib/links/links";
import { cn } from "@/lib/utils/cn";

function Item({ active, onClick, children, muted }: { active?: boolean; onClick: () => void; children: ReactNode; muted?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
        muted && "text-muted-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {active && <Check className="size-4 shrink-0" />}
    </button>
  );
}

const Divider = () => <div className="-mx-1 my-1 border-t" />;


/** `Workspace / Project ▾` breadcrumb with a switcher on each part. */
export function ScopeSwitcher({ workspace, project }: { workspace: string; project: string | null }) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const multi = useMultiWorkspace();
  const workspaces = useWorkspaces();
  const projects = useProjects(workspace);
  const [wsOpen, setWsOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [creating, setCreating] = useState<"workspace" | "project" | null>(null);

  const current = workspaces.data?.items.find((w) => w.slug === workspace);
  const active = projects.data?.items ?? [];
  const currentProject = active.find((p) => p.slug === project);
  const go = (to: string) => {
    setWsOpen(false);
    setProjectOpen(false);
    navigate(to);
  };
  const toProject = (slug: string) => go(switchProjectLink(pathname, { workspace, project: slug }, search));

  return (
    <div className="flex min-w-0 items-center gap-1 text-sm">
      <Popover open={wsOpen} onOpenChange={setWsOpen}>
        <PopoverTrigger className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 font-medium hover:bg-accent" aria-label="Switch workspace">
          <span className="max-w-40 truncate">{current?.name ?? workspace}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Workspaces</div>
          {workspaces.data?.items.map((w) => (
            <Item key={w.id} active={w.slug === workspace} onClick={() => go(`/w/${w.slug}`)}>
              {w.name}
              <span className="ml-2 text-xs text-muted-foreground">{w.role}</span>
            </Item>
          ))}
          <Divider />
          {multi && (
            <Item muted onClick={() => (setWsOpen(false), setCreating("workspace"))}>
              <span className="inline-flex items-center gap-2">
                <Plus className="size-4" /> Create workspace
              </span>
            </Item>
          )}
          <Item muted onClick={() => go(settingsLink(workspace))}>
            <span className="inline-flex items-center gap-2">
              <Settings className="size-4" /> Workspace settings
            </span>
          </Item>
        </PopoverContent>
      </Popover>
      <span className="text-muted-foreground">/</span>
      <Popover open={projectOpen} onOpenChange={setProjectOpen}>
        <PopoverTrigger className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 font-medium hover:bg-accent" aria-label="Switch project">
          <span className={cn("max-w-48 truncate", !project && "text-muted-foreground")}>
            {project === ALL_PROJECTS ? "All projects" : (currentProject?.name ?? project ?? "Project")}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1">
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Projects</div>
          <Item active={project === ALL_PROJECTS} onClick={() => toProject(ALL_PROJECTS)}>
            <span className="inline-flex items-center gap-2">
              <Layers className="size-4" /> All projects
            </span>
          </Item>
          <Divider />
          <div className="max-h-72 overflow-y-auto">
            {active.map((p) => (
              <Item key={p.id} active={p.slug === project} onClick={() => toProject(p.slug)}>
                {p.name}
                <span className="ml-2 font-mono text-xs text-muted-foreground">{p.slug}</span>
              </Item>
            ))}
          </div>
          <Divider />
          <Item muted onClick={() => (setProjectOpen(false), setCreating("project"))}>
            <span className="inline-flex items-center gap-2">
              <Plus className="size-4" /> New project
            </span>
          </Item>
          <Item muted onClick={() => go(settingsLink(workspace, "projects"))}>
            <span className="inline-flex items-center gap-2">
              <Settings className="size-4" /> Manage projects
            </span>
          </Item>
        </PopoverContent>
      </Popover>

      <NameDialog
        open={creating === "workspace"}
        onOpenChange={(open) => !open && setCreating(null)}
        title="Create workspace"
        description="A workspace has its own members, AWS accounts and projects."
        submitLabel="Create workspace"
        placeholder="Acme"
        onSubmit={async (name) => {
          const w = await createWorkspace({ name });
          await refreshWorkspace();
          navigate(`/w/${w.slug}`);
        }}
      />
      <NameDialog
        open={creating === "project"}
        onOpenChange={(open) => !open && setCreating(null)}
        title="New project"
        description="Projects group functions, for example one app in one environment (checkout-prod, checkout-staging). Each has its own ingest keys."
        submitLabel="Create project"
        placeholder="checkout-prod"
        onSubmit={async (name) => {
          const p = await createProject(workspace, { name });
          await refreshWorkspace(workspace);
          navigate(pageLink({ workspace, project: p.slug }, "functions"));
        }}
      />
    </div>
  );
}
