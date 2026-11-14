import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { describeMatcher } from "@/components/aws/rules-section";
import { errorMessage } from "@/components/workspaces/name-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createRule, dryRun, refreshAws } from "@/lib/api/aws";
import { useProjects } from "@/lib/api/hooks";
import type { DryRunResponse, RuleMatcher } from "@/lib/api/types";
import { useWorkspace } from "@/lib/links/use-scope";
import { slugify } from "@/lib/utils/slug";

export interface TraceTarget {
  title: string;
  matcher: RuleMatcher;
  /** Project slug to suggest, e.g. derived from the stack name. */
  suggested?: string | null;
  /** The account's preselected project. */
  fallback?: string | null;
}

/** Summary of what a dry run would do, in words. */
export function dryRunSummary(r: DryRunResponse): string {
  const parts = [
    r.summary.trace && `${r.summary.trace} start tracing`,
    r.summary.unchanged && `${r.summary.unchanged} already traced there`,
    r.summary.other && `${r.summary.other} go elsewhere (tag, manual choice or earlier rule)`,
    r.summary.excluded && `${r.summary.excluded} excluded`,
    r.summary.unsupported && `${r.summary.unsupported} unsupported`,
  ].filter(Boolean);
  return `${r.count} function${r.count === 1 ? "" : "s"} match${r.count === 1 ? "es" : ""}${parts.length ? `: ${parts.join(", ")}` : ""}.`;
}

/**
 * "Trace" for a stack or a filter: pick or create the project, preview the matches, and save the
 * matcher as a rule, so new matching functions are traced automatically.
 */
export function TraceDialog({ target, onOpenChange }: { target: TraceTarget | null; onOpenChange: (open: boolean) => void }) {
  const workspace = useWorkspace();
  const projects = useProjects(workspace);
  const [mode, setMode] = useState<"new" | "existing">("existing");
  const [existing, setExisting] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<DryRunResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = projects.data?.items ?? [];

  useEffect(() => {
    if (!target) return;
    setError(null);
    setPreview(null);
    const suggested = target.suggested ?? "";
    const match = list.find((p) => p.slug === suggested);
    if (suggested && !match) {
      setMode("new");
      setName(suggested);
    } else {
      setMode("existing");
      setExisting(match?.slug ?? target.fallback ?? list.find((p) => p.default)?.slug ?? list[0]?.slug ?? "");
    }
    // Initialise when a new target opens; the project list is read once.
  }, [target]);

  // The slug the server will most likely give a new project (for the preview only).
  const project = mode === "new" ? slugify(name) : existing;
  useEffect(() => {
    if (!target || !project) return;
    const t = setTimeout(() => {
      dryRun(workspace, target.matcher, project).then(setPreview, () => setPreview(null));
    }, 250);
    return () => clearTimeout(t);
  }, [workspace, target, project]);

  async function save() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await createRule(workspace, mode === "new" ? { matcher: target.matcher, new_project: { name: name.trim() } } : { matcher: target.matcher, project: existing });
      await refreshAws();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target?.title}</DialogTitle>
          <DialogDescription>
            Saves a rule (<span className="font-mono">{target ? describeMatcher(target.matcher) : ""}</span>
            ), so functions added later are traced too.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex gap-1">
            <Button size="sm" variant={mode === "new" ? "secondary" : "ghost"} onClick={() => setMode("new")}>
              New project
            </Button>
            <Button size="sm" variant={mode === "existing" ? "secondary" : "ghost"} onClick={() => setMode("existing")} disabled={!list.length}>
              Existing project
            </Button>
          </div>
          {mode === "new" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="td-name">Project name</Label>
              <Input id="td-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          ) : (
            <Select value={existing} onValueChange={setExisting}>
              <SelectTrigger aria-label="Project">
                <SelectValue placeholder="Pick a project" />
              </SelectTrigger>
              <SelectContent>
                {list.map((p) => (
                  <SelectItem key={p.id} value={p.slug}>
                    {p.name} <span className="ml-1 font-mono text-xs text-muted-foreground">{p.slug}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="min-h-5 text-sm text-muted-foreground">{preview ? dryRunSummary(preview) : "Checking which functions match…"}</p>
          <p className="text-xs text-muted-foreground">
            Moving a function to another project only affects new data; data already ingested stays in its project.
          </p>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <DialogFooter>
          <Button onClick={() => void save()} disabled={busy || !project || (mode === "new" && !name.trim())}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            Trace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
