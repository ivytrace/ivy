import { useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import { errorMessage } from "@/components/workspaces/name-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltipped } from "@/components/ui/tooltipped";
import { deleteRule, refreshAws, reorderRules, updateRule } from "@/lib/api/aws";
import { useRules } from "@/lib/api/hooks";
import type { RuleMatcher } from "@/lib/api/types";
import { useWorkspace } from "@/lib/links/use-scope";

/** `stack billing-api-prod · region eu-west-1` */
export function describeMatcher(m: RuleMatcher): string {
  const parts = [
    m.stack && `stack ${m.stack}`,
    m.name && `name ${m.name}`,
    m.tag && `tag ${m.tag}`,
    m.region && `region ${m.region}`,
    m.account_id && `account ${m.account_id}`,
  ].filter(Boolean);
  return parts.join(" · ") || "everything";
}

/** The workspace's rules in evaluation order: first enabled match wins. */
export function RulesSection() {
  const workspace = useWorkspace();
  const rules = useRules();
  const [error, setError] = useState<string | null>(null);
  const items = rules.data?.items ?? [];

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refreshAws();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const move = (index: number, by: -1 | 1) => {
    const order = items.map((r) => r.id);
    const [id] = order.splice(index, 1);
    order.splice(index + by, 0, id);
    void run(() => reorderRules(workspace, order));
  };

  return (
    <div className="mt-10">
      <h3 className="font-semibold">Tracing rules</h3>
      <p className="mb-4 mt-1 max-w-2xl text-sm text-muted-foreground">
        Rules select functions for tracing and name their project. They're checked in order; the first enabled match wins. Tags
        (<span className="font-mono">ivy:trace</span>, <span className="font-mono">ivy:project</span>) and choices made per function come first.
        New functions that match are traced on the next sync. Create rules from an account's function list.
      </p>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No rules yet.</div>
      ) : (
        <ol className="divide-y rounded-md border">
          {items.map((rule, i) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <span className="w-5 text-right tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{describeMatcher(rule.matcher)}</span>
              <span className="text-xs text-muted-foreground">→</span>
              <span className="font-mono text-xs">{rule.project ?? rule.project_id}</span>
              <Switch
                checked={rule.enabled}
                onCheckedChange={(enabled) => void run(() => updateRule(workspace, rule.id, { enabled }))}
                aria-label="Enabled"
              />
              <div className="flex">
                <Button variant="ghost" size="icon" className="size-7" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  <ArrowUp className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" className="size-7" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                  <ArrowDown className="size-4" />
                </Button>
                <Tooltipped title="Delete (functions only this rule selected are untraced on the next sync)">
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => void run(() => deleteRule(workspace, rule.id))} aria-label="Delete rule">
                    <Trash2 className="size-4" />
                  </Button>
                </Tooltipped>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
