import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Project } from "@/lib/api/types";
import { refreshWorkspace, updateProject } from "@/lib/api/workspaces";
import { errorMessage } from "./name-dialog";

/** The projects that can take over as default when `archiving` is archived, oldest first (as the API lists them). */
export const defaultCandidates = (projects: Project[], archiving: Project) => projects.filter((p) => !p.archived && p.id !== archiving.id);

/** What archiving the default project does, in the dialog's words. */
export function ArchiveDefaultNotice({ project, next }: { project: Project; next: Project | undefined }) {
  if (!next) {
    return (
      <p className="text-sm text-muted-foreground">
        A workspace needs at least one project. Create another project before archiving {project.name}.
      </p>
    );
  }
  return (
    <div className="grid gap-2 text-sm text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">{next.name}</span> becomes the default project; keys without a project and new auto-traced
        functions without a rule go there.
      </p>
      <p className="text-amber-300">Keys created for {project.name} stop working.</p>
      <p>Its data stays readable until retention removes it, and you can unarchive it later.</p>
    </div>
  );
}

/** Confirms archiving the workspace's default project and picks the project that becomes the default. */
export function ArchiveDefaultDialog({
  workspace,
  project,
  projects,
  onClose,
}: {
  workspace: string;
  project: Project;
  projects: Project[];
  onClose: () => void;
}) {
  const candidates = defaultCandidates(projects, project);
  const [next, setNext] = useState(candidates[0]?.slug ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = candidates.find((p) => p.slug === next);

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      await updateProject(workspace, project.slug, { archived: true, new_default: next });
      await refreshWorkspace(workspace);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive {project.name}?</DialogTitle>
          <DialogDescription>It is the workspace's default project, so another project takes over as default.</DialogDescription>
        </DialogHeader>
        {candidates.length > 0 ? (
          <div className="grid gap-2">
            <Label htmlFor="new-default">New default project</Label>
            <Select value={next} onValueChange={setNext}>
              <SelectTrigger id="new-default" aria-label="New default project">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((p) => (
                  <SelectItem key={p.id} value={p.slug}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <ArchiveDefaultNotice project={project} next={chosen} />
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void archive()} disabled={busy || !chosen}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Archive project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
