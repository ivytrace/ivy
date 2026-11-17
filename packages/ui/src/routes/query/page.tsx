import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Loader2, Play, Plus, Trash2 } from "lucide-react";

import { ResultsTable } from "@/components/query/results-table";
import { SchemaPanel } from "@/components/query/schema-panel";
import { SqlEditor, type SqlEditorHandle } from "@/components/query/sql-editor";
import { LoadingState } from "@/components/common/states";
import { rangeLabel, useTimeRange } from "@/components/layout/time-range";
import { errorMessage, NameDialog } from "@/components/workspaces/name-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltipped } from "@/components/ui/tooltipped";
import { useProjects } from "@/lib/api/hooks";
import { createSavedQuery, deleteSavedQuery, runQuery, updateSavedQuery, useSavedQueries, type QueryResponse, type SavedQuery } from "@/lib/api/query";
import { ALL_PROJECTS } from "@/lib/links/links";
import { useScope } from "@/lib/links/use-scope";
import { cn } from "@/lib/utils/cn";

const STARTER = `SELECT
  function,
  count() AS invocations,
  countIf(status = 'error') AS errors,
  round(quantile(0.95)(duration_ms)) AS p95_ms
FROM invocations
GROUP BY function
ORDER BY invocations DESC`;

const NEW = "__new";
const draftKey = (workspace: string) => `ivy/query-draft/${workspace}`;

function readDraft(workspace: string): string | null {
  try {
    return localStorage.getItem(draftKey(workspace));
  } catch {
    return null;
  }
}

function writeDraft(workspace: string, sql: string) {
  try {
    localStorage.setItem(draftKey(workspace), sql);
  } catch {
    // storage unavailable: the draft just isn't kept
  }
}

type DialogKind = "save" | "rename" | "delete" | null;

function SavedList({ items, selected, onSelect }: { items: SavedQuery[]; selected: string | null; onSelect: (id: string | null) => void }) {
  return (
    <ul className="space-y-0.5">
      <li>
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent", !selected && "bg-accent")}
        >
          <Plus className="size-3.5 text-muted-foreground" />
          New query
        </button>
      </li>
      {items.map((q) => (
        <li key={q.id}>
          <button
            type="button"
            onClick={() => onSelect(q.id)}
            className={cn("block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent", selected === q.id && "bg-accent")}
          >
            {q.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function QueryPage() {
  const scope = useScope();
  const { range } = useTimeRange();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("q");
  const saved = useSavedQueries(scope.workspace);
  const selected = saved.data?.items.find((q) => q.id === selectedId) ?? null;
  const projects = useProjects(scope.workspace);
  const projectLabel = scope.project === ALL_PROJECTS ? "All projects" : (projects.data?.items.find((p) => p.slug === scope.project)?.name ?? scope.project);

  const [sql, setSql] = useState(() => (selectedId ? "" : (readDraft(scope.workspace) ?? STARTER)));
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const editor = useRef<SqlEditorHandle>(null);
  const pending = useRef<AbortController | null>(null);
  const lastRun = useRef<string | null>(null);
  const loaded = useRef<string | null>(null);

  const dirty = selected ? sql !== selected.sql : false;

  async function run(text = sql) {
    if (!text.trim()) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    lastRun.current = text;
    setRunning(true);
    setError(null);
    try {
      const next = await runQuery(scope, text, range, controller.signal);
      if (!controller.signal.aborted) setResult(next);
    } catch (err) {
      if (controller.signal.aborted) return;
      setResult(null);
      setError(errorMessage(err));
    } finally {
      if (pending.current === controller) setRunning(false);
    }
  }

  // Opening a saved query loads its SQL and runs it.
  useEffect(() => {
    if (!selected || loaded.current === selected.id) return;
    loaded.current = selected.id;
    setSql(selected.sql);
    void run(selected.sql);
  }, [selected?.id]);

  // A new time range or project re-runs the last query, so the results match the header.
  const scopeKey = `${scope.workspace}/${scope.project}/${JSON.stringify(range)}`;
  const shownScope = useRef(scopeKey);
  useEffect(() => {
    if (shownScope.current === scopeKey) return;
    shownScope.current = scopeKey;
    if (lastRun.current) void run(lastRun.current);
  }, [scopeKey]);

  useEffect(() => () => pending.current?.abort(), []);

  function change(next: string) {
    setSql(next);
    if (!selectedId) writeDraft(scope.workspace, next);
  }

  function select(id: string | null) {
    if (id === selectedId) return;
    if (id) {
      setParams({ q: id });
      return;
    }
    loaded.current = null;
    setParams({});
    setSql(readDraft(scope.workspace) ?? STARTER);
    setResult(null);
    setError(null);
    lastRun.current = null;
  }

  async function save() {
    if (!selected) {
      setDialog("save");
      return;
    }
    if (!dirty) return;
    setSaving(true);
    try {
      await updateSavedQuery(scope.workspace, selected.id, { sql });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveAs(name: string) {
    const created = await createSavedQuery(scope.workspace, { name, sql });
    loaded.current = created.id;
    setParams({ q: created.id });
  }

  async function remove() {
    if (!selected) return;
    setDeleteError(null);
    try {
      await deleteSavedQuery(scope.workspace, selected.id);
      setDialog(null);
      select(null);
    } catch (err) {
      setDeleteError(errorMessage(err));
    }
  }

  const items = saved.data?.items ?? [];

  return (
    <div className="flex gap-6">
      <aside className="hidden w-60 shrink-0 space-y-6 lg:block">
        <section>
          <h2 className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Saved queries</h2>
          {saved.data ? <SavedList items={items} selected={selectedId} onSelect={select} /> : <LoadingState className="p-4" />}
        </section>
        <section>
          <h2 className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Tables</h2>
          <SchemaPanel onInsert={(text) => editor.current?.insert(text)} />
        </section>
      </aside>

      <div className="min-w-0 flex-1 space-y-4">
        <div>
          <h1 className="truncate text-2xl font-bold">{selected?.name ?? (selectedId && !saved.data ? "Query" : "New query")}</h1>
          <p className="text-sm text-muted-foreground">
            SQL (ClickHouse) over the invocations, spans and logs of {projectLabel === "All projects" ? "all projects" : projectLabel},{" "}
            {rangeLabel(range).toLowerCase()}. Saved queries are shared with everyone in the workspace.
          </p>
        </div>

        <div className="lg:hidden">
          <Select value={selectedId ?? NEW} onValueChange={(v) => select(v === NEW ? null : v)}>
            <SelectTrigger className="h-9 w-full" aria-label="Saved query">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW}>New query</SelectItem>
              {items.map((q) => (
                <SelectItem key={q.id} value={q.id}>
                  {q.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-md border bg-card">
          <SqlEditor ref={editor} value={sql} onChange={change} onRun={() => void run()} onSave={() => void save()} />
          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
            <Button size="sm" onClick={() => void run()} disabled={running || !sql.trim()}>
              {running ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Play className="mr-1.5 size-3.5" />}
              Run
            </Button>
            <span className="hidden text-xs text-muted-foreground sm:inline">⌘↵</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {selected ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => void save()} disabled={!dirty || saving}>
                    {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                    {dirty ? "Save" : "Saved"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDialog("save")}>
                    Save as…
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDialog("rename")}>
                    Rename
                  </Button>
                  <Tooltipped title="Delete this saved query">
                    <Button size="icon" variant="ghost" className="size-8" aria-label="Delete saved query" onClick={() => setDialog("delete")}>
                      <Trash2 className="size-4" />
                    </Button>
                  </Tooltipped>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setDialog("save")} disabled={!sql.trim()}>
                  Save…
                </Button>
              )}
            </div>
          </div>
        </div>

        <details className="rounded-md border px-3 py-2 lg:hidden">
          <summary className="cursor-pointer text-sm">Tables</summary>
          <div className="mt-2">
            <SchemaPanel onInsert={(text) => editor.current?.insert(text)} />
          </div>
        </details>

        {error ? (
          <div className="rounded-md border border-red-500/40 bg-red-500/5 p-4">
            <div className="text-sm font-medium text-red-400">Query failed</div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{error}</pre>
          </div>
        ) : result ? (
          <div className={cn(running && "opacity-60")}>
            <ResultsTable result={result} scope={scope} />
          </div>
        ) : running ? (
          <LoadingState className="rounded-md border" label="Running…" />
        ) : (
          <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
            Run a query to see results. The tables only hold this {scope.project === ALL_PROJECTS ? "workspace’s" : "project’s"} data in the selected time
            range, so there’s no need to filter on those.
          </p>
        )}
      </div>

      <NameDialog
        open={dialog === "save"}
        onOpenChange={(open) => setDialog(open ? "save" : null)}
        title="Save query"
        description="Saved queries are shared with everyone in this workspace."
        submitLabel="Save"
        initialName={selected ? `${selected.name} (copy)` : ""}
        placeholder="Slowest checkout routes"
        onSubmit={saveAs}
      />
      <NameDialog
        open={dialog === "rename"}
        onOpenChange={(open) => setDialog(open ? "rename" : null)}
        title="Rename query"
        submitLabel="Rename"
        initialName={selected?.name}
        onSubmit={async (name) => {
          if (selected) await updateSavedQuery(scope.workspace, selected.id, { name });
        }}
      />
      <Dialog open={dialog === "delete"} onOpenChange={(open) => setDialog(open ? "delete" : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{selected?.name}”?</DialogTitle>
            <DialogDescription>It’s removed for everyone in this workspace.</DialogDescription>
          </DialogHeader>
          {deleteError && <p className="text-sm text-red-400">{deleteError}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
