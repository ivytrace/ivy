import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Project } from "@/lib/api/types";
import { refreshWorkspace, updateProject } from "@/lib/api/workspaces";
import { errorMessage } from "./name-dialog";

/** What archiving a project does, in the dialog's words. The same for every project. */
export function ArchiveProjectNotice({ project, last }: { project: Project; last: boolean }) {
  return (
    <div className="grid gap-2 text-sm text-muted-foreground">
      <p className="text-amber-300">Keys created for {project.name} stop working, and its traced functions are no longer traced.</p>
      <p>Its data stays readable until retention removes it, and you can unarchive it later.</p>
      {last ? <p>It is the workspace's last active project: you can create a new one afterwards.</p> : null}
    </div>
  );
}

/** Confirms archiving a project. */
export function ArchiveProjectDialog({ workspace, project, last, onClose }: { workspace: string; project: Project; last: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      await updateProject(workspace, project.slug, { archived: true });
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
          <DialogDescription>Archiving is how a project is removed; nothing is deleted.</DialogDescription>
        </DialogHeader>
        <ArchiveProjectNotice project={project} last={last} />
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void archive()} disabled={busy}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Archive project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
