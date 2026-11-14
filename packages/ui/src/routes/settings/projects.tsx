import { useState } from "react";
import { Link } from "react-router";
import { Archive, ArchiveRestore, KeyRound, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { SectionHeader } from "@/components/common/section-header";
import { ArchiveDefaultDialog } from "@/components/workspaces/archive-default";
import { ErrorState, LoadingState } from "@/components/common/states";
import { KeyReveal } from "@/components/workspaces/key-reveal";
import { errorMessage, NameDialog, UrlSetting } from "@/components/workspaces/name-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltipped } from "@/components/ui/tooltipped";
import { useKeys, useProjects } from "@/lib/api/hooks";
import type { CreatedKey, Project } from "@/lib/api/types";
import { createKey, createProject, refreshWorkspace, revokeKey, updateProject, updateWorkspace } from "@/lib/api/workspaces";
import { pageLink } from "@/lib/links/links";
import { useWorkspace } from "@/lib/links/use-scope";
import { cn } from "@/lib/utils/cn";
import { formatAgo } from "@/lib/utils/format";

export default function ProjectsSettings() {
  const workspace = useWorkspace();
  const projects = useProjects(workspace, true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [archivingDefault, setArchivingDefault] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refreshWorkspace(workspace);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function setArchived(p: Project, archived: boolean) {
    if (archived && p.default) setArchivingDefault(p);
    else void run(() => updateProject(workspace, p.slug, { archived }));
  }

  return (
    <div>
      <SectionHeader
        title="Projects"
        description="A project groups functions, usually one app in one environment (checkout-prod and checkout-staging are two projects). Each project has its own ingest keys."
      >
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 size-4" />
          New project
        </Button>
      </SectionHeader>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {projects.error ? (
        <ErrorState error={projects.error} onRetry={() => void projects.mutate()} className="rounded-md border" />
      ) : !projects.data ? (
        <LoadingState className="rounded-md border" />
      ) : (
        <div className="grid gap-3">
          {projects.data.items.map((p) => (
            <ProjectCard
              key={p.id}
              workspace={workspace}
              project={p}
              onEdit={() => setEditing(p)}
              onArchive={(archived) => setArchived(p, archived)}
              onMakeDefault={() => void run(() => updateWorkspace(workspace, { default_project: p.slug }))}
            />
          ))}
        </div>
      )}

      {archivingDefault && projects.data ? (
        <ArchiveDefaultDialog
          key={archivingDefault.id}
          workspace={workspace}
          project={archivingDefault}
          projects={projects.data.items}
          onClose={() => setArchivingDefault(null)}
        />
      ) : null}
      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title="New project"
        description="Usually one app in one environment; environments are separate projects (checkout-prod, checkout-staging)."
        submitLabel="Create project"
        placeholder="checkout-prod"
        onSubmit={async (name) => {
          await createProject(workspace, { name });
          await refreshWorkspace(workspace);
        }}
      />
      <NameDialog
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        title="Rename project"
        description="Renaming keeps the project's URL, keys and data."
        submitLabel="Save"
        initialName={editing?.name}
        onSubmit={async (name) => {
          await updateProject(workspace, editing!.slug, { name });
          await refreshWorkspace(workspace);
        }}
      >
        {editing && (
          <div className="border-t pt-4">
            <UrlSetting
              prefix={`/w/${workspace}/`}
              slug={editing.slug}
              onChange={async (slug) => {
                const next = await updateProject(workspace, editing.slug, { slug });
                setEditing(next);
                await refreshWorkspace(workspace);
              }}
            />
          </div>
        )}
      </NameDialog>
    </div>
  );
}

function ProjectCard({
  workspace,
  project,
  onEdit,
  onArchive,
  onMakeDefault,
}: {
  workspace: string;
  project: Project;
  onEdit: () => void;
  onArchive: (archived: boolean) => void;
  onMakeDefault: () => void;
}) {
  const [showKeys, setShowKeys] = useState(false);
  return (
    <div className={cn("rounded-md border p-4", project.archived && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-48 flex-1">
          {project.archived ? (
            <span className="font-semibold">{project.name}</span>
          ) : (
            <Link to={pageLink({ workspace, project: project.slug }, "functions")} className="font-semibold text-primary hover:underline">
              {project.name}
            </Link>
          )}
          <div className="font-mono text-xs text-muted-foreground">
            /w/{workspace}/{project.slug}
            {project.default ? <span className="ml-2 font-sans">· default</span> : null}
            {project.archived ? <span className="ml-2 font-sans">· archived</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {!project.archived && !project.default ? (
            <Tooltipped title="Keys without a project and new auto-traced functions without a rule go to the default project">
              <Button variant="ghost" size="sm" onClick={onMakeDefault}>
                Make default
              </Button>
            </Tooltipped>
          ) : null}
          {!project.archived && (
            <Button variant="outline" size="sm" onClick={() => setShowKeys((v) => !v)}>
              <KeyRound className="mr-2 size-4" />
              Ingest keys
            </Button>
          )}
          <Tooltipped title="Rename">
            <Button variant="ghost" size="icon" onClick={onEdit} aria-label={`Rename ${project.name}`}>
              <Pencil className="size-4" />
            </Button>
          </Tooltipped>
          <Tooltipped title={project.archived ? "Unarchive" : "Archive: stops its keys and its traced functions"}>
            <Button variant="ghost" size="icon" onClick={() => onArchive(!project.archived)} aria-label={project.archived ? `Unarchive ${project.name}` : `Archive ${project.name}`}>
              {project.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            </Button>
          </Tooltipped>
        </div>
      </div>
      {showKeys && <ProjectKeys workspace={workspace} project={project.slug} />}
    </div>
  );
}

function ProjectKeys({ workspace, project }: { workspace: string; project: string }) {
  const keys = useKeys(workspace, project);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setCreated(await createKey(workspace, project, name.trim() || "Ingest key"));
      setName("");
      await keys.mutate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await revokeKey(workspace, project, id);
      await keys.mutate();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="mt-4 grid gap-3 border-t pt-4">
      <p className="text-xs text-muted-foreground">
        Spans sent with a project's key land in that project. The auto-trace key is managed by Ivy and written into traced Lambda functions;
        revoking it makes the next sync write a new one.
      </p>
      {keys.data?.items.length ? (
        <div className="divide-y rounded-md border text-sm">
          {keys.data.items.map((k) => (
            <div key={k.id} className="flex items-center gap-3 px-3 py-2">
              <span className="font-mono text-xs">{k.prefix}…</span>
              <span className="flex-1 truncate">{k.name}</span>
              <span className="text-xs text-muted-foreground">{k.kind === "user" ? `created ${formatAgo(k.created_at)}` : k.kind}</span>
              {k.kind !== "bootstrap" && (
                <Tooltipped title="Revoke">
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => void revoke(k.id)} aria-label={`Revoke ${k.name}`}>
                    <Trash2 className="size-4" />
                  </Button>
                </Tooltipped>
              )}
            </div>
          ))}
        </div>
      ) : keys.data ? (
        <p className="text-sm text-muted-foreground">No keys yet.</p>
      ) : null}
      <div className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. ci" className="h-8 w-60" />
        <Button size="sm" onClick={() => void create()} disabled={busy}>
          {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Plus className="mr-2 size-4" />}
          Create key
        </Button>
      </div>
      {created && <KeyReveal created={created} />}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
