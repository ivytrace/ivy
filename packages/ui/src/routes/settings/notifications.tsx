import { useState } from "react";
import { Info } from "lucide-react";

import { SectionHeader } from "@/components/common/section-header";
import { ErrorState, LoadingState } from "@/components/common/states";
import { errorMessage } from "@/components/workspaces/name-dialog";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api/client";
import { updateNotifications } from "@/lib/api/alerts";
import { useNotifications } from "@/lib/api/hooks";

/** Your own notification settings: the weekly digest per workspace you are in. */
export default function NotificationsSettings() {
  const notifications = useNotifications();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const header = <SectionHeader title="Notifications" description="Your own settings, for each workspace you are a member of." />;
  if (notifications.error instanceof ApiError && notifications.error.status === 403) {
    return (
      <div className="max-w-2xl">
        {header}
        <p className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">
          Notification settings are per user, and this server runs without sign-in. The digest goes to the addresses in <code className="font-mono">IVY_DIGEST_TO</code>.
        </p>
      </div>
    );
  }
  if (notifications.error) return <ErrorState error={notifications.error} onRetry={() => void notifications.mutate()} className="rounded-md border" />;
  if (!notifications.data) return <LoadingState className="rounded-md border" />;
  const n = notifications.data;

  async function toggle(workspace: string, digest: boolean) {
    setBusy(workspace);
    setError(null);
    try {
      await updateNotifications(workspace, digest);
      await notifications.mutate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-2xl">
      {header}
      {!n.digest_available && (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          Email is not set up on this server, so no digest is sent yet. Your choices are kept for when it is.
        </p>
      )}
      <section className="rounded-md border">
        <div className="border-b px-4 py-3">
          <h3 className="font-medium">Weekly email digest</h3>
          <p className="text-sm text-muted-foreground">Sent to {n.email ?? "your email address"}. Every email also has a one-click unsubscribe link.</p>
        </div>
        <div className="divide-y">
          {n.items.map((item) => (
            <label key={item.workspace.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="flex-1 font-medium">{item.workspace.name}</span>
              <span className="text-xs text-muted-foreground">{item.digest ? "Subscribed" : "Unsubscribed"}</span>
              <Switch
                checked={item.digest}
                disabled={busy === item.workspace.slug}
                onCheckedChange={(v) => void toggle(item.workspace.slug, v)}
                aria-label={`Weekly digest of ${item.workspace.name}`}
              />
            </label>
          ))}
        </div>
      </section>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </div>
  );
}
