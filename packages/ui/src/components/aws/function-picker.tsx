import { useEffect, useMemo, useState } from "react";
import { Ban, Layers, Trash2, X } from "lucide-react";

import { NewBadge } from "@/components/aws/account-parts";
import { FunctionChoiceMenu, FunctionProject, NeedsProject, TraceStateLabel } from "@/components/aws/trace-state";
import { dryRunSummary, TraceDialog, type TraceTarget } from "@/components/aws/trace-dialog";
import { EmptyState } from "@/components/common/states";
import { errorMessage } from "@/components/workspaces/name-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltipped } from "@/components/ui/tooltipped";
import { deleteRule, dryRun, refreshAws, setFunctionsChoice, updateRule } from "@/lib/api/aws";
import { useProjects } from "@/lib/api/hooks";
import type { AwsAccount, AwsFunction, DryRunResponse, FunctionGroup, RuleMatcher } from "@/lib/api/types";
import { preselectProject, readLastTraceProject, rememberTraceProject } from "@/lib/aws/last-project";
import { useWorkspace } from "@/lib/links/use-scope";
import { formatAgo } from "@/lib/utils/format";

const fnKey = (f: Pick<AwsFunction, "region" | "name">) => `${f.region}/${f.name}`;
const ANY = "__any";

interface Filter {
  name: string;
  stack: string;
  tag: string;
  region: string;
}

const EMPTY_FILTER: Filter = { name: "", stack: "", tag: "", region: "" };

function matcherOf(account: AwsAccount, f: Filter): RuleMatcher | null {
  const m: RuleMatcher = { account_id: account.account_id };
  if (f.name.trim()) m.name = f.name.trim();
  if (f.stack.trim()) m.stack = f.stack.trim();
  if (f.tag.trim()) m.tag = f.tag.trim();
  if (f.region) m.region = f.region;
  return Object.keys(m).length > 1 ? m : null;
}

/**
 * An account's functions grouped by CloudFormation stack: trace a stack into a project (saved as a
 * rule), filter by name/stack/tag/region with a live dry run, select functions, or choose per function.
 */
export function FunctionPicker({ account, groups, onError }: { account: AwsAccount; groups: FunctionGroup[]; onError: (message: string) => void }) {
  const workspace = useWorkspace();
  const projects = useProjects(workspace);
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER);
  const [preview, setPreview] = useState<DryRunResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProject, setBulkProject] = useState("");
  const [target, setTarget] = useState<TraceTarget | null>(null);
  const [busy, setBusy] = useState(false);

  const matcher = useMemo(() => matcherOf(account, filter), [account, filter]);
  useEffect(() => {
    setPreview(null);
    if (!matcher) return;
    const t = setTimeout(() => {
      dryRun(workspace, matcher).then(setPreview, (err) => onError(errorMessage(err)));
    }, 300);
    return () => clearTimeout(t);
  }, [workspace, matcher, onError]);

  const matching = preview ? new Set(preview.items.map((i) => fnKey(i.function))) : null;
  const visible = groups
    .map((g) => ({ ...g, functions: matching ? g.functions.filter((f) => matching.has(fnKey(f))) : g.functions }))
    .filter((g) => g.functions.length > 0);
  const all = groups.flatMap((g) => g.functions);
  const regions = [...new Set(all.map((f) => f.region))].sort();
  // Always asked: preselects the project last used for tracing in this browser, else nothing.
  const bulkTarget = bulkProject || preselectProject(projects.data?.items ?? [], readLastTraceProject(workspace));

  const toggle = (keys: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  async function applySelected(mode: "trace" | "exclude") {
    setBusy(true);
    try {
      const fns = all.filter((f) => selected.has(fnKey(f))).map((f) => ({ account_id: f.account_id, region: f.region, name: f.name }));
      if (mode === "trace") rememberTraceProject(workspace, bulkTarget);
      await setFunctionsChoice(workspace, fns, mode === "trace" ? { mode, project: bulkTarget } : { mode });
      setSelected(new Set());
      await refreshAws();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function ruleAction(action: () => Promise<unknown>) {
    try {
      await action();
      await refreshAws();
    } catch (err) {
      onError(errorMessage(err));
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border p-3">
        <Input value={filter.name} onChange={(e) => setFilter({ ...filter, name: e.target.value })} placeholder="Name, e.g. orders-*" className="h-8 w-48" aria-label="Function name pattern" />
        <Input value={filter.stack} onChange={(e) => setFilter({ ...filter, stack: e.target.value })} placeholder="Stack, e.g. api-*" className="h-8 w-44" aria-label="Stack name pattern" />
        <Input value={filter.tag} onChange={(e) => setFilter({ ...filter, tag: e.target.value })} placeholder="Tag key=value" className="h-8 w-40" aria-label="Tag" />
        <Select value={filter.region || ANY} onValueChange={(v) => setFilter({ ...filter, region: v === ANY ? "" : v })}>
          <SelectTrigger className="h-8 w-40 font-mono" aria-label="Region">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any region</SelectItem>
            {regions.map((r) => (
              <SelectItem key={r} value={r} className="font-mono">
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {matcher && (
          <>
            <span className="text-sm text-muted-foreground">{preview ? dryRunSummary(preview) : "Matching…"}</span>
            <div className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setFilter(EMPTY_FILTER)}>
                <X className="mr-1 size-4" />
                Clear
              </Button>
              <Button
                size="sm"
                disabled={!preview?.count}
                onClick={() => setTarget({ title: "Trace all matching functions", matcher })}
              >
                Trace all matching
              </Button>
            </div>
          </>
        )}
      </div>

      {selected.size > 0 && (
        <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-background/95 p-2 text-sm shadow">
          <span className="px-2 tabular-nums">{selected.size} selected</span>
          <Select value={bulkTarget} onValueChange={setBulkProject}>
            <SelectTrigger className="h-8 w-52" aria-label="Project for selected functions">
              <SelectValue placeholder="Project" />
            </SelectTrigger>
            <SelectContent>
              {projects.data?.items.map((p) => (
                <SelectItem key={p.id} value={p.slug}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => void applySelected("trace")} disabled={busy || !bulkTarget}>
            Trace selected
          </Button>
          <Button size="sm" variant="outline" onClick={() => void applySelected("exclude")} disabled={busy}>
            <Ban className="mr-1 size-4" />
            Exclude selected
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState title="No functions match" />
      ) : (
        <div className="grid gap-4">
          {visible.map((g) => (
            <StackGroup
              key={`${g.stack ?? ""}/${g.region ?? ""}`}
              group={g}
              selected={selected}
              onToggle={toggle}
              onError={onError}
              onTrace={() =>
                setTarget({
                  title: `Trace stack ${g.stack}`,
                  matcher: { account_id: account.account_id, stack: g.stack!, region: g.region ?? undefined },
                  suggested: g.suggested_project,
                })
              }
              onRuleEnabled={(enabled) => g.rule && void ruleAction(() => updateRule(workspace, g.rule!.id, { enabled }))}
              onRuleDelete={() => g.rule && void ruleAction(() => deleteRule(workspace, g.rule!.id))}
            />
          ))}
        </div>
      )}
      <TraceDialog target={target} onOpenChange={(open) => !open && setTarget(null)} />
    </div>
  );
}

function StackGroup({
  group,
  selected,
  onToggle,
  onError,
  onTrace,
  onRuleEnabled,
  onRuleDelete,
}: {
  group: FunctionGroup;
  selected: Set<string>;
  onToggle: (keys: string[], on: boolean) => void;
  onError: (message: string) => void;
  onTrace: () => void;
  onRuleEnabled: (enabled: boolean) => void;
  onRuleDelete: () => void;
}) {
  const keys = group.functions.map(fnKey);
  const allSelected = keys.length > 0 && keys.every((k) => selected.has(k));
  const traced = group.functions.filter((f) => f.state === "traced").length;
  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/20 px-4 py-2.5">
        <input
          type="checkbox"
          className="size-4 accent-emerald-400"
          checked={allSelected}
          onChange={(e) => onToggle(keys, e.target.checked)}
          aria-label={`Select all in ${group.stack ?? "other functions"}`}
        />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Layers className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-semibold">{group.stack ?? "Other functions"}</span>
          {group.region && <span className="font-mono text-xs text-muted-foreground">{group.region}</span>}
          <span className="text-xs text-muted-foreground">
            {group.counts.total} function{group.counts.total === 1 ? "" : "s"} · {traced} traced
          </span>
          {group.counts.new > 0 && <NewBadge count={group.counts.new} />}
        </div>
        {group.rule ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Traced into</span>
            <span className="font-mono text-xs">{group.rule.project ?? group.rule.project_id}</span>
            <Tooltipped title={group.rule.enabled ? "Rule on: new functions in this stack are traced" : "Rule off"}>
              <span>
                <Switch checked={group.rule.enabled} onCheckedChange={onRuleEnabled} aria-label="Stack rule enabled" />
              </span>
            </Tooltipped>
            <Tooltipped title="Delete the rule (its functions are untraced on the next sync)">
              <Button variant="ghost" size="icon" className="size-7" onClick={onRuleDelete} aria-label="Delete stack rule">
                <Trash2 className="size-4" />
              </Button>
            </Tooltipped>
          </div>
        ) : group.stack ? (
          <Button size="sm" variant="outline" onClick={onTrace}>
            Trace stack
          </Button>
        ) : null}
      </div>
      <div className="divide-y">
        {group.functions.map((f) => (
          <div key={fnKey(f)} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-emerald-400"
              checked={selected.has(fnKey(f))}
              disabled={f.state === "unsupported"}
              onChange={(e) => onToggle([fnKey(f)], e.target.checked)}
              aria-label={`Select ${f.name}`}
            />
            <div className="min-w-56 flex-1">
              <span className="font-medium">{f.name}</span>
              {f.new && <span className="ml-2 rounded-full bg-sky-400/15 px-1.5 text-[10px] font-medium uppercase text-sky-300">new</span>}
              <div className="text-xs text-muted-foreground">
                <span className="font-mono">{f.runtime || "—"}</span>
                {!group.region && <span className="ml-2 font-mono">{f.region}</span>}
                {f.last_modified && <span className="ml-2">modified {formatAgo(f.last_modified)}</span>}
                {Object.entries(f.tags)
                  .filter(([k]) => !k.startsWith("aws:"))
                  .slice(0, 3)
                  .map(([k, v]) => (
                    <span key={k} className="ml-2 font-mono">
                      {k}={v}
                    </span>
                  ))}
              </div>
              {f.state === "needs_project" && <NeedsProject fn={f} onError={onError} />}
            </div>
            <div className="w-28">
              <TraceStateLabel state={f.state} reason={f.reason} />
            </div>
            <div className="w-48">
              <FunctionProject fn={f} />
            </div>
            <FunctionChoiceMenu fn={f} onError={onError} />
          </div>
        ))}
      </div>
    </div>
  );
}
