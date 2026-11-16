import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

import { errorMessage } from "@/components/workspaces/name-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { applyAlertSettings } from "@/lib/api/alerts";
import type { AlertSettings, ApplyAlertsResult, Project, SlackChannel } from "@/lib/api/types";

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/** The "When to post" rule in one line, as it will be copied. */
export function describeRule(s: AlertSettings): string {
  const limits = `then at most every ${plural(s.interval_minutes, "minute")} or every ${plural(s.every_occurrences, "occurrence")}`;
  return `Slack messages ${s.slack_enabled ? "on" : "off"}. First seen, ${limits}. Throttles ${s.include_throttles ? "on" : "off"}`;
}

/** The Slack channels that will be copied, by name (`#alerts, #oncall`). */
export const channelList = (channels: SlackChannel[]) => channels.map((c) => `#${c.channel.replace(/^#/, "")}`).join(", ");

/** The project checklist with "Select all", and what is copied: the rule and the Slack channels. */
export function ApplyToProjectsForm(props: {
  projects: Project[];
  selected: Set<string>;
  settings: AlertSettings;
  /** The source's working channels. */
  channels: SlackChannel[];
  source: string;
  unsaved: boolean;
  disabled?: boolean;
  onChange: (selected: Set<string>) => void;
}) {
  const { projects, selected, onChange } = props;
  const all = projects.length > 0 && projects.every((p) => selected.has(p.id));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange(next);
  };
  return (
    <div className="grid gap-4 text-sm">
      <div className="rounded-md border bg-muted/20 p-3">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Copied from {props.source}</div>
        <p className="mt-1">{describeRule(props.settings)}.</p>
        <p className="mt-1">Slack channels: {props.channels.length ? channelList(props.channels) : "none"}.</p>
        {props.channels.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            The channels are shared, not reconnected: removing the app or a channel in Slack affects every project that uses it.
          </p>
        )}
        {props.unsaved && <p className="mt-1 text-xs text-amber-300">Includes changes not saved to {props.source} yet; save them there separately.</p>}
      </div>
      <div className="rounded-md border">
        <label className="flex items-center gap-3 border-b bg-muted/20 px-3 py-2 font-medium">
          <input
            type="checkbox"
            className="size-4 accent-emerald-400"
            checked={all}
            disabled={props.disabled}
            onChange={(e) => onChange(new Set(e.target.checked ? projects.map((p) => p.id) : []))}
            aria-label="Select all projects"
          />
          <span className="flex-1">Select all</span>
          <span className="text-xs font-normal text-muted-foreground">
            {selected.size} of {projects.length} selected
          </span>
        </label>
        <div className="max-h-72 divide-y overflow-y-auto">
          {projects.map((p) => (
            <label key={p.id} className="flex items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                className="size-4 accent-emerald-400"
                checked={selected.has(p.id)}
                disabled={props.disabled}
                onChange={(e) => toggle(p.id, e.target.checked)}
                aria-label={`Apply to ${p.name}`}
              />
              <span className="flex-1 truncate">{p.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{p.slug}</span>
            </label>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Replaces the selected projects' "When to post" settings and adds the Slack channels. Channels a project already has are skipped, and
        its existing errors aren't posted as new.
      </p>
    </div>
  );
}

export const resultText = (r: ApplyAlertsResult) =>
  `Updated ${plural(r.updated, "project")}${r.channels_added ? `, added ${plural(r.channels_added, "Slack channel")}` : ""}.`;

/** What happened, after applying. */
export function ApplyResult({ result }: { result: ApplyAlertsResult }) {
  return (
    <div className="grid gap-2 text-sm">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="size-4 text-emerald-400" />
        <span>{resultText(result)}</span>
      </div>
      <p className="text-muted-foreground">{result.projects.map((p) => p.name).join(", ")}</p>
    </div>
  );
}

/** "Apply to other projects…": copies the current "When to post" form to the projects picked here, in one request. */
export function ApplyToProjectsDialog(props: {
  workspace: string;
  source: Project;
  projects: Project[];
  settings: AlertSettings;
  channels: SlackChannel[];
  unsaved: boolean;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyAlertsResult | null>(null);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      setResult(await applyAlertSettings(props.workspace, props.source.id, [...selected], props.settings));
    } catch (err) {
      setError(`${errorMessage(err)} No project was changed.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply to other projects</DialogTitle>
          <DialogDescription>Use the same alert rule and Slack channels for several projects at once.</DialogDescription>
        </DialogHeader>
        {result ? (
          <ApplyResult result={result} />
        ) : (
          <ApplyToProjectsForm
            projects={props.projects}
            selected={selected}
            settings={props.settings}
            channels={props.channels}
            source={props.source.name}
            unsaved={props.unsaved}
            disabled={busy}
            onChange={setSelected}
          />
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <DialogFooter>
          {result ? (
            <Button variant="outline" onClick={props.onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={props.onClose}>
                Cancel
              </Button>
              <Button onClick={() => void apply()} disabled={busy || selected.size === 0}>
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                {selected.size ? `Apply to ${plural(selected.size, "project")}` : "Apply"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
