import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronRight, Eye, Hash, Loader2, Mail, MessageSquare, UserRound } from "lucide-react";

import { SectionHeader } from "@/components/common/section-header";
import { ErrorState, LoadingState } from "@/components/common/states";
import { errorMessage } from "@/components/workspaces/name-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { previewDigest, updateDigest, updateNotifications } from "@/lib/api/alerts";
import { useAlerts, useConfig, useDigest, useProjects } from "@/lib/api/hooks";
import type { AlertsResponse, DigestInfo, DigestPreview, Project } from "@/lib/api/types";
import { useAuth } from "@/lib/auth/provider";
import { alertsLink } from "@/lib/links/links";
import { useWorkspace } from "@/lib/links/use-scope";
import { NotConfigured } from "./alerts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Mondays at 08:00 UTC" for a simple weekly cron, else the expression itself. */
export function describeSchedule(cron: string): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7])$/.exec(cron.trim());
  if (!m) return `${cron} (cron, UTC)`;
  return `${DAYS[Number(m[3]) % 7]}s at ${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")} UTC`;
}

/** Workspace settings → Notifications: the weekly digest (workspace and your own), and Slack alerts per project. */
export default function NotificationsSettings() {
  const workspace = useWorkspace();
  const { data: config } = useConfig();
  const { user } = useAuth();
  const digest = useDigest(workspace);
  const projects = useProjects(workspace);
  const [busy, setBusy] = useState<"workspace" | "me" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  if (digest.error) return <ErrorState error={digest.error} onRetry={() => void digest.mutate()} className="rounded-md border" />;
  if (!digest.data) return <LoadingState className="rounded-md border" />;
  const d = digest.data;
  const emailConfigured = config?.alerts?.email ?? d.available;

  async function run(key: "workspace" | "me", fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await digest.mutate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
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
      <SectionHeader title="Notifications" description="How Ivy tells this workspace about errors: a weekly email digest, and Slack alerts per project." />
      <div className="grid gap-6">
        <DigestCard
          digest={d}
          configured={emailConfigured}
          busy={busy === "workspace"}
          previewing={previewing}
          onToggle={(enabled) => void run("workspace", () => updateDigest(workspace, enabled))}
          onPreview={() => void openPreview()}
        />
        {emailConfigured && (
          <YourEmailCard digest={d} email={user?.email ?? null} busy={busy === "me"} onToggle={(on) => void run("me", () => updateNotifications(workspace, on))} />
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <SlackCard workspace={workspace} configured={config?.alerts?.slack} projects={projects.data?.items.filter((p) => !p.archived)} />
      </div>

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

function Card({ icon: Icon, title, description, action, children }: { icon: typeof Mail; title: string; description: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="rounded-md border p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex gap-3">
          <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <h3 className="font-medium">{title}</h3>
            <div className="mt-1 text-sm text-muted-foreground">{description}</div>
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The workspace's weekly digest: on/off (owners), schedule, recipients and a preview. */
export function DigestCard(props: {
  digest: DigestInfo;
  configured: boolean;
  busy: boolean;
  previewing: boolean;
  onToggle: (enabled: boolean) => void;
  onPreview: () => void;
}) {
  const { digest: d, configured } = props;
  return (
    <Card
      icon={Mail}
      title="Weekly email digest"
      description={
        <>
          <p>New error groups, the top error groups with their trend against the week before, and totals. No payloads.</p>
          <p className="mt-1">
            {describeSchedule(d.schedule)}, covering the seven days before. Skipped in weeks without data.
            {configured && ` ${d.recipients === 1 ? "1 recipient" : `${d.recipients} recipients`}.`}
          </p>
        </>
      }
      action={
        configured && (
          <Switch
            checked={d.enabled}
            disabled={!d.can_edit || props.busy}
            onCheckedChange={props.onToggle}
            aria-label="Send this workspace's weekly digest"
          />
        )
      }
    >
      {configured && !d.can_edit && <p className="mt-3 text-xs text-muted-foreground">Only workspace owners can change this.</p>}
      {!configured && (
        <div className="mt-4">
          <NotConfigured
            title="Email is not set up on this server"
            missing={d.missing}
            hint="The digest is sent over SMTP and links back to Ivy, so the API needs these environment variables (see docs/implementation/alerts.md). You can still preview it."
          />
        </div>
      )}
      <div className="mt-5 border-t pt-4">
        <Button variant="outline" onClick={props.onPreview} disabled={props.previewing}>
          {props.previewing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Eye className="mr-2 size-4" />}
          Preview this week's digest
        </Button>
      </div>
    </Card>
  );
}

/** Your own subscription to this workspace's digest; every member can change it. */
export function YourEmailCard({ digest: d, email, busy, onToggle }: { digest: DigestInfo; email: string | null; busy: boolean; onToggle: (on: boolean) => void }) {
  if (d.subscribed === null) {
    return (
      <Card
        icon={UserRound}
        title="Your email"
        description={
          <>
            This server runs without sign-in, so there are no personal settings. The digest goes to the addresses in{" "}
            <code className="font-mono">IVY_DIGEST_TO</code>.
          </>
        }
      />
    );
  }
  return (
    <Card
      icon={UserRound}
      title="Your email"
      description={
        <>
          <p>Send the weekly digest to me{email ? ` (${email})` : ""}. Every email also has a one-click unsubscribe link.</p>
          {!d.enabled && <p className="mt-1">The digest is switched off for this workspace, so nothing is sent right now.</p>}
        </>
      }
      action={<Switch checked={d.subscribed} disabled={busy} onCheckedChange={onToggle} aria-label="Send the weekly digest to me" />}
    />
  );
}

function SlackCard({ workspace, configured, projects }: { workspace: string; configured: boolean | undefined; projects: Project[] | undefined }) {
  if (configured === false) {
    return (
      <Card icon={MessageSquare} title="Slack alerts" description="Ivy posts to Slack when an error group is first seen, then at most as often as each project sets.">
        <div className="mt-4">{projects?.[0] && <SlackNotConfigured workspace={workspace} project={projects[0].slug} />}</div>
      </Card>
    );
  }
  return (
    <Card
      icon={MessageSquare}
      title="Slack alerts"
      description="Set per project: each project picks its own channels and how often to post. Ivy posts when an error group is first seen, then at most as often as the project sets."
    >
      {!projects ? (
        <LoadingState className="mt-4 rounded-md border" />
      ) : (
        <div className="mt-4 divide-y rounded-md border">
          {projects.map((p) => (
            <LoadedSlackRow key={p.id} workspace={workspace} project={p} />
          ))}
        </div>
      )}
    </Card>
  );
}

function SlackNotConfigured({ workspace, project }: { workspace: string; project: string }) {
  const alerts = useAlerts(workspace, project);
  return (
    <NotConfigured
      title="Slack alerts are not set up on this server"
      missing={alerts.data?.available.missing ?? []}
      hint="Create a Slack app from deploy/slack-app-manifest.example.yml and set these environment variables on the API (see docs/implementation/alerts.md)."
    />
  );
}

function LoadedSlackRow({ workspace, project }: { workspace: string; project: Project }) {
  const alerts = useAlerts(workspace, project.slug);
  return <SlackRow workspace={workspace} project={project} alerts={alerts.data} />;
}

/** One project's Slack status: its channels (or "Not connected") and a link to its Alerts settings. */
export function SlackRow({ workspace, project, alerts }: { workspace: string; project: Project; alerts: AlertsResponse | undefined }) {
  const channels = alerts?.integrations ?? [];
  const broken = channels.some((c) => c.status === "broken");
  return (
    <Link to={alertsLink(workspace, project.slug)} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-accent">
      <span className="min-w-40 flex-1 font-medium">{project.name}</span>
      {!alerts ? (
        <span className="text-xs text-muted-foreground">…</span>
      ) : channels.length === 0 ? (
        <span className="text-xs text-muted-foreground">Not connected</span>
      ) : (
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {channels.map((c) => (
            <span key={c.id} className="flex items-center gap-0.5">
              <Hash className="size-3" />
              {c.channel.replace(/^#/, "") || "channel"}
            </span>
          ))}
          {!alerts.settings.slack_enabled && <span>(off)</span>}
        </span>
      )}
      {alerts && channels.length > 0 && (broken ? <Badge variant="error">Broken</Badge> : <Badge variant="success">Connected</Badge>)}
      <span className="flex items-center text-xs text-primary">
        Alerts settings
        <ChevronRight className="size-3.5" />
      </span>
    </Link>
  );
}
