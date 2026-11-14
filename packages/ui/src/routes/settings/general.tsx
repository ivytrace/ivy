import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Loader2, Trash2 } from "lucide-react";

import { errorMessage, UrlSetting } from "@/components/workspaces/name-dialog";
import { SectionHeader } from "@/components/common/section-header";
import { ErrorState, LoadingState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMultiWorkspace, useWorkspaceInfo } from "@/lib/api/hooks";
import { deleteWorkspace, refreshWorkspace, updateWorkspace } from "@/lib/api/workspaces";
import type { Workspace } from "@/lib/api/types";
import { settingsLink } from "@/lib/links/links";
import { useWorkspace } from "@/lib/links/use-scope";

export default function GeneralSettings() {
  const workspace = useWorkspace();
  const info = useWorkspaceInfo(workspace);
  if (info.error) return <ErrorState error={info.error} onRetry={() => void info.mutate()} className="rounded-md border" />;
  if (!info.data) return <LoadingState className="rounded-md border" />;
  return <General ws={info.data} />;
}

function General({ ws }: { ws: Workspace }) {
  const navigate = useNavigate();
  const multi = useMultiWorkspace();
  const owner = ws.role === "owner";
  const [name, setName] = useState(ws.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => setName(ws.name), [ws.name]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateWorkspace(ws.slug, { name: name.trim() });
      await refreshWorkspace(ws.slug);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl">
      <SectionHeader title="General" description={owner ? undefined : "Only owners can change the workspace."} />
      <form onSubmit={(e) => void save(e)} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="ws-name">Name</Label>
          <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!owner} />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {owner && (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save
            </Button>
            {saved && <span className="text-sm text-emerald-400">Saved</span>}
          </div>
        )}
      </form>

      <div className="mt-6">
        <UrlSetting
          prefix="/w/"
          slug={ws.slug}
          disabled={!owner || ws.default}
          disabledReason={ws.default ? "The default workspace keeps the URL /w/default." : "Only owners can change the URL."}
          onChange={async (slug) => {
            const next = await updateWorkspace(ws.slug, { slug });
            await refreshWorkspace(next.slug);
            navigate(settingsLink(next.slug), { replace: true });
          }}
        />
      </div>

      {owner && multi && !ws.default && (
        <div className="mt-10 rounded-md border border-red-400/30 p-4">
          <h3 className="font-medium">Delete workspace</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Revokes every ingest key and removes all members. Disconnect its AWS accounts first. Traces are kept until retention removes them.
          </p>
          <Button variant="destructive" className="mt-3" onClick={() => setDeleting(true)}>
            <Trash2 className="mr-2 size-4" />
            Delete workspace
          </Button>
        </div>
      )}
      <DeleteWorkspaceDialog ws={ws} open={deleting} onOpenChange={setDeleting} onDeleted={() => navigate("/", { replace: true })} />
    </div>
  );
}

function DeleteWorkspaceDialog({ ws, open, onOpenChange, onDeleted }: { ws: Workspace; open: boolean; onOpenChange: (o: boolean) => void; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setConfirm("");
      setError(null);
    }
  }, [open]);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteWorkspace(ws.slug, confirm);
      try {
        localStorage.removeItem("ivy.lastScope");
      } catch {
        // ignore
      }
      await refreshWorkspace();
      onOpenChange(false);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {ws.name}?</DialogTitle>
          <DialogDescription>
            This can't be undone. Type <span className="font-mono text-foreground">{ws.slug}</span> to confirm.
          </DialogDescription>
        </DialogHeader>
        <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="font-mono" autoFocus aria-label="Workspace slug" />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <DialogFooter>
          <Button variant="destructive" onClick={() => void remove()} disabled={busy || confirm !== ws.slug}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            Delete workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
