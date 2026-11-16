import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { AlertTriangle, CheckCircle2, Copy, Hash, Loader2, Send, Trash2 } from "lucide-react";

import { ApplyToProjectsDialog } from "@/components/alerts/apply-to-projects";
import { SectionHeader } from "@/components/common/section-header";
import { ErrorState, LoadingState } from "@/components/common/states";
import { errorMessage } from "@/components/workspaces/name-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltipped } from "@/components/ui/tooltipped";
import { connectSlack, removeSlackChannel, testSlackChannel, updateAlertSettings } from "@/lib/api/alerts";
import { useAlerts, useProjects } from "@/lib/api/hooks";
import type { AlertSettings, AlertsResponse, Project, SlackChannel } from "@/lib/api/types";
import { alertsLink, readLastScope } from "@/lib/links/links";
import { useWorkspace } from "@/lib/links/use-scope";
import { formatAgo } from "@/lib/utils/format";

/** Project settings → Alerts: Slack channels and how often a message is sent per error group. */
export default function AlertsSettings() {
  const workspace = useWorkspace();
  const { project } = useParams();
  const navigate = useNavigate();
  const projects = useProjects(workspace);

  if (projects.error) return <ErrorState error={projects.error} onRetry={() => void projects.mutate()} className="rounded-md border" />;
  if (!projects.data) return <LoadingState className="rounded-md border" />;
  const active = projects.data.items.filter((p) => !p.archived);
  if (!project) {
    const last = readLastScope(workspace);
    const pick = active.find((p) => p.slug === last?.project) ?? active[0];
    return pick ? <Navigate to={alertsLink(workspace, pick.slug)} replace /> : null;
  }

  return (
    <div className="max-w-2xl">
      <SectionHeader
        title="Alerts"
        description="Ivy posts to Slack when an error group of a project is first seen, then at most as often as you set below. Settings are per project."
      >
        <Select value={project} onValueChange={(slug) => navigate(alertsLink(workspace, slug))}>
          <SelectTrigger className="w-56" aria-label="Project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {active.map((p) => (
              <SelectItem key={p.id} value={p.slug}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SectionHeader>
      <ProjectAlerts key={project} workspace={workspace} project={project} projects={active} />
    </div>
  );
}

function ProjectAlerts({ workspace, project, projects }: { workspace: string; project: string; projects: Project[] }) {
  const alerts = useAlerts(workspace, project);
  if (alerts.error) return <ErrorState error={alerts.error} onRetry={() => void alerts.mutate()} className="rounded-md border" />;
  if (!alerts.data) return <LoadingState className="rounded-md border" />;
  return (
    <div className="grid gap-6">
      <OAuthResult />
      {alerts.data.available.slack ? (
        <>
          <Channels workspace={workspace} project={project} data={alerts.data} onChange={() => void alerts.mutate()} />
          <Frequency workspace={workspace} project={project} projects={projects} data={alerts.data} onSaved={() => void alerts.mutate()} />
        </>
      ) : (
        <NotConfigured
          title="Slack alerts are not set up on this server"
          missing={alerts.data.available.missing}
          hint="Create a Slack app from deploy/slack-app-manifest.example.yml and set these environment variables on the API (see docs/implementation/alerts.md)."
        />
      )}
    </div>
  );
}

export function NotConfigured({ title, missing, hint }: { title: string; missing: string[]; hint: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed p-5">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4 text-amber-400" />
        {title}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{hint}</p>
      {missing.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {missing.map((name) => (
            <code key={name} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
              {name}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

/** The `?slack=` result Slack's redirect brings back. */
function OAuthResult() {
  const [params, setParams] = useSearchParams();
  const result = params.get("slack");
  if (!result) return null;
  const dismiss = () => {
    params.delete("slack");
    params.delete("message");
    setParams(params, { replace: true });
  };
  const ok = result === "connected";
  const text = ok ? "Slack is connected. Send a test message to check the channel." : result === "denied" ? "Slack was not connected: the request was cancelled." : (params.get("message") ?? "Connecting Slack failed.");
  return (
    <div className={`flex items-start gap-3 rounded-md border p-3 text-sm ${ok ? "border-emerald-400/40" : "border-red-400/40"}`} role="status">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-400" />}
      <span className="flex-1">{text}</span>
      <button className="text-xs text-muted-foreground hover:text-foreground" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}

function Channels({ workspace, project, data, onChange }: { workspace: string; project: string; data: AlertsResponse; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const connect = () =>
    run("connect", async () => {
      const { url } = await connectSlack(workspace, project);
      window.location.assign(url);
    });

  const addButton = (
    <Button variant={data.integrations.length ? "outline" : "default"} onClick={() => void connect()} disabled={!data.can_edit || busy === "connect"}>
      {busy === "connect" ? <Loader2 className="mr-2 size-4 animate-spin" /> : <SlackMark className="mr-2 size-4" />}
      {data.integrations.length ? "Add another channel" : "Add to Slack"}
    </Button>
  );

  return (
    <section className="rounded-md border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Slack channels</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            You pick the channel in Slack. Messages show the error type and message, function, counts and a link; never payloads.
          </p>
        </div>
        {data.can_edit ? addButton : <Tooltipped title="Only workspace owners can change alerts">{<span>{addButton}</span>}</Tooltipped>}
      </div>
      {data.integrations.length > 0 && (
        <div className="mt-4 divide-y rounded-md border">
          {data.integrations.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              canEdit={data.can_edit}
              busy={busy}
              tested={tested[c.id]}
              onTest={() =>
                void run(`test:${c.id}`, async () => {
                  const r = await testSlackChannel(workspace, project, c.id);
                  setTested((t) => ({ ...t, [c.id]: r.ok ? "Sent" : `Failed: ${r.error}` }));
                  onChange();
                })
              }
              onRemove={() =>
                void run(`remove:${c.id}`, async () => {
                  await removeSlackChannel(workspace, project, c.id);
                  onChange();
                })
              }
            />
          ))}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}

function ChannelRow(props: { channel: SlackChannel; canEdit: boolean; busy: string | null; tested?: string; onTest: () => void; onRemove: () => void }) {
  const { channel: c, canEdit, busy } = props;
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
      <Hash className="size-4 text-muted-foreground" />
      <div className="min-w-40 flex-1">
        <div className="font-medium">{c.channel.replace(/^#/, "") || "channel"}</div>
        <div className="text-xs text-muted-foreground">
          {c.team_name} · added {formatAgo(c.created_at)}
        </div>
        {c.status === "broken" && (
          <div className="mt-1 text-xs text-red-400">Slack rejected the last message ({c.error}). Reconnect the channel or remove it.</div>
        )}
        {props.tested && <div className={`mt-1 text-xs ${props.tested === "Sent" ? "text-emerald-400" : "text-red-400"}`}>{props.tested}</div>}
      </div>
      {c.status === "broken" ? <Badge variant="error">Broken</Badge> : <Badge variant="success">Connected</Badge>}
      {canEdit && (
        <>
          <Button variant="outline" size="sm" onClick={props.onTest} disabled={busy === `test:${c.id}`}>
            {busy === `test:${c.id}` ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" />}
            Send test message
          </Button>
          <Tooltipped title="Remove from this project">
            <Button variant="ghost" size="icon" className="size-8" onClick={props.onRemove} aria-label={`Remove #${c.channel}`} disabled={busy === `remove:${c.id}`}>
              <Trash2 className="size-4" />
            </Button>
          </Tooltipped>
        </>
      )}
    </div>
  );
}

/** Slack's mark in the button's text colour (monochrome), for the "Add to Slack" button. */
function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 122.8 122.8" className={className} aria-hidden="true">
      <path fill="currentColor" d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9zm6.5 0a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 1 1-25.8 0z" />
      <path fill="currentColor" d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9zm0 6.5a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 0 1 0-25.8z" />
      <path fill="currentColor" d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97zm-6.5 0a12.9 12.9 0 0 1-25.8 0V12.9a12.9 12.9 0 1 1 25.8 0z" />
      <path fill="currentColor" d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97zm0-6.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 0 1 0 25.8z" />
    </svg>
  );
}

function Frequency(props: { workspace: string; project: string; projects: Project[]; data: AlertsResponse; onSaved: () => void }) {
  const { workspace, project, data, onSaved } = props;
  const [form, setForm] = useState<AlertSettings>(data.settings);
  const [intervalText, setIntervalText] = useState(String(data.settings.interval_minutes));
  const [every, setEvery] = useState(String(data.settings.every_occurrences));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    setForm(data.settings);
    setIntervalText(String(data.settings.interval_minutes));
    setEvery(String(data.settings.every_occurrences));
  }, [data.settings]);

  const disabled = !data.can_edit;
  const intervalN = Number(intervalText);
  const everyN = Number(every);
  const valid = Number.isInteger(intervalN) && intervalN >= 1 && intervalN <= 10080 && Number.isInteger(everyN) && everyN >= 1 && everyN <= 1_000_000;
  const dirty =
    form.slack_enabled !== data.settings.slack_enabled ||
    form.include_throttles !== data.settings.include_throttles ||
    intervalN !== data.settings.interval_minutes ||
    everyN !== data.settings.every_occurrences;
  const source = props.projects.find((p) => p.slug === project);
  const others = props.projects.filter((p) => p.slug !== project);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateAlertSettings(workspace, project, { ...form, interval_minutes: intervalN, every_occurrences: everyN });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-md border p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-medium">When to post</h3>
          <p className="mt-1 text-sm text-muted-foreground">{disabled ? "Only workspace owners can change alerts." : "Per error group, for this project."}</p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="slack-enabled" className="text-sm">
            Slack messages
          </Label>
          <Switch id="slack-enabled" checked={form.slack_enabled} disabled={disabled} onCheckedChange={(v) => setForm({ ...form, slack_enabled: v })} />
        </div>
      </div>

      <div className={`mt-5 grid gap-3 text-sm ${form.slack_enabled ? "" : "opacity-50"}`}>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-emerald-400" />
          <span>When an error group is first seen</span>
          <span className="text-xs text-muted-foreground">(always)</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <span>then at most every</span>
          <Input
            aria-label="Minutes between messages"
            value={intervalText}
            onChange={(e) => setIntervalText(e.target.value)}
            disabled={disabled || !form.slack_enabled}
            inputMode="numeric"
            className="h-8 w-20 text-center"
          />
          <span>minutes or every</span>
          <Input
            aria-label="Occurrences between messages"
            value={every}
            onChange={(e) => setEvery(e.target.value)}
            disabled={disabled || !form.slack_enabled}
            inputMode="numeric"
            className="h-8 w-24 text-center"
          />
          <span>occurrences, whichever comes first.</span>
        </div>
        <p className="pl-6 text-xs text-muted-foreground">Includes failures outside the handler (init errors, timeouts, out of memory, crashes).</p>
        <label className="mt-2 flex items-center gap-2">
          <Switch checked={form.include_throttles} disabled={disabled || !form.slack_enabled} onCheckedChange={(v) => setForm({ ...form, include_throttles: v })} />
          <span>Also alert on throttles</span>
          <span className="text-xs text-muted-foreground">(Lambda's concurrency limit; off by default)</span>
        </label>
      </div>

      {!valid && <p className="mt-3 text-sm text-red-400">Use whole numbers: 1 to 10080 minutes, 1 to 1,000,000 occurrences.</p>}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {!disabled && (
        <div className="mt-5 flex items-center gap-3">
          <Button onClick={() => void save()} disabled={busy || !dirty || !valid}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            Save
          </Button>
          {others.length > 0 && source && (
            <Button variant="outline" onClick={() => setApplying(true)} disabled={!valid}>
              <Copy className="mr-2 size-4" />
              Apply to other projects…
            </Button>
          )}
          {saved && !dirty && <span className="text-sm text-emerald-400">Saved</span>}
        </div>
      )}
      {applying && source && (
        <ApplyToProjectsDialog
          workspace={workspace}
          source={source}
          projects={others}
          settings={{ ...form, interval_minutes: intervalN, every_occurrences: everyN }}
          channels={data.integrations.filter((c) => c.status === "ok")}
          unsaved={dirty}
          onClose={() => setApplying(false)}
        />
      )}
    </section>
  );
}
