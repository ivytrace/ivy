import { useState } from "react";
import { Link } from "react-router";
import { Eye, Loader2, Mail } from "lucide-react";

import { SectionHeader } from "@/components/common/section-header";
import { ErrorState, LoadingState } from "@/components/common/states";
import { errorMessage } from "@/components/workspaces/name-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { previewDigest, updateDigest } from "@/lib/api/alerts";
import { useDigest } from "@/lib/api/hooks";
import type { DigestPreview } from "@/lib/api/types";
import { settingsLink } from "@/lib/links/links";
import { useWorkspace } from "@/lib/links/use-scope";
import { NotConfigured } from "./alerts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Mondays at 08:00 UTC" for a simple weekly cron, else the expression itself. */
export function describeSchedule(cron: string): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7])$/.exec(cron.trim());
  if (!m) return `${cron} (cron, UTC)`;
  return `${DAYS[Number(m[3]) % 7]}s at ${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")} UTC`;
}

/** Workspace settings → Email digest: on/off for the workspace, and a preview. */
export default function DigestSettings() {
  const workspace = useWorkspace();
  const digest = useDigest(workspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  if (digest.error) return <ErrorState error={digest.error} onRetry={() => void digest.mutate()} className="rounded-md border" />;
  if (!digest.data) return <LoadingState className="rounded-md border" />;
  const d = digest.data;

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await updateDigest(workspace, enabled);
      await digest.mutate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function openPreview() {
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await previewDigest(workspace));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <SectionHeader
        title="Email digest"
        description="A weekly email to the workspace's members: new error groups, the top error groups with their trend against the week before, and totals. No payloads."
      />
      {!d.available && (
        <div className="mb-6">
          <NotConfigured
            title="Email is not set up on this server"
            missing={d.missing}
            hint="The digest is sent over SMTP and links back to Ivy, so the API needs these environment variables (see docs/implementation/alerts.md). You can still preview it."
          />
        </div>
      )}
      <section className="rounded-md border p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <Mail className="mt-0.5 size-5 text-muted-foreground" />
            <div>
              <h3 className="font-medium">Weekly digest</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {describeSchedule(d.schedule)}, covering the seven days before. Skipped in weeks without data.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {d.recipients === 1 ? "1 recipient" : `${d.recipients} recipients`}
                {d.subscribed !== null && (
                  <>
                    {" · "}
                    {d.subscribed ? "including you" : "you unsubscribed"} (
                    <Link to={settingsLink(workspace, "notifications")} className="link">
                      your notifications
                    </Link>
                    )
                  </>
                )}
              </p>
            </div>
          </div>
          <Switch
            checked={d.enabled && d.available}
            disabled={!d.can_edit || !d.available || busy}
            onCheckedChange={(v) => void toggle(v)}
            aria-label="Send the weekly digest"
          />
        </div>
        {!d.can_edit && <p className="mt-3 text-xs text-muted-foreground">Only workspace owners can switch the digest on or off.</p>}
        <div className="mt-5 flex items-center gap-3 border-t pt-4">
          <Button variant="outline" onClick={() => void openPreview()} disabled={previewing}>
            {previewing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Eye className="mr-2 size-4" />}
            Preview this week's digest
          </Button>
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </section>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="pr-6 text-base">{preview?.subject}</DialogTitle>
            <DialogDescription>
              {preview?.empty ? "No data in the last seven days: this week's digest would be skipped." : "As members would get it, with the last seven days of data."}
            </DialogDescription>
          </DialogHeader>
          {preview && <iframe title="Digest preview" srcDoc={preview.html} sandbox="" className="h-[65vh] w-full rounded-md border bg-white" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
