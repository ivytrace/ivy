import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { CheckCircle2, Cloud, KeyRound, Loader2 } from "lucide-react";

import { errorMessage } from "@/components/workspaces/name-dialog";
import { KeyReveal } from "@/components/workspaces/key-reveal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useProjects } from "@/lib/api/hooks";
import type { CreatedKey, Project } from "@/lib/api/types";
import { createKey, firstProject, refreshWorkspace } from "@/lib/api/workspaces";
import { awsAccountsLink, pageLink } from "@/lib/links/links";
import { cn } from "@/lib/utils/cn";

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 rounded-md border p-5">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full border text-sm font-medium",
          done && "border-emerald-400/50 text-emerald-400",
        )}
      >
        {done ? <CheckCircle2 className="size-4" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}

/** The untouched project every workspace starts with: the first step renames it. */
const isPristine = (projects: Project[]) => projects.length === 1 && projects[0].default && projects[0].slug === "default";

/** Empty state of a new workspace: name the first project, then connect AWS or copy an ingest key. */
export function Onboarding({ workspace }: { workspace: string }) {
  const navigate = useNavigate();
  const projects = useProjects(workspace);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<CreatedKey | null>(null);
  const list = projects.data?.items ?? [];
  const pristine = isPristine(list);
  const project = list.find((p) => p.default) ?? list[0];

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const next = await firstProject(workspace, list, name.trim());
      await refreshWorkspace(workspace);
      navigate(pageLink({ workspace, project: next.slug }, "functions"), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function newKey() {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      setKey(await createKey(workspace, project.slug, "First key"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-4 grid max-w-2xl gap-4">
      <div>
        <h2 className="text-xl font-semibold">Welcome to Ivy</h2>
        <p className="mt-1 text-sm text-muted-foreground">Two steps until your first traces show up here.</p>
      </div>
      <Step n={1} done={!pristine} title="Create your first project">
        {pristine ? (
          <form onSubmit={(e) => void rename(e)} className="grid gap-2">
            <p className="text-sm text-muted-foreground">
              A project is usually one app in one environment, for example <span className="font-mono">checkout-prod</span>. Create one per
              environment.
            </p>
            <Label htmlFor="first-project" className="sr-only">
              Project name
            </Label>
            <div className="flex gap-2">
              <Input id="first-project" value={name} onChange={(e) => setName(e.target.value)} placeholder="checkout-prod" className="max-w-xs" />
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                Create project
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            {list.length} project{list.length === 1 ? "" : "s"}: {list.map((p) => p.name).join(", ")}.
          </p>
        )}
      </Step>
      <Step n={2} done={!!key} title="Send traces">
        <div className="grid gap-3 text-sm">
          <p className="text-muted-foreground">
            Connect an AWS account and pick the functions (or CloudFormation stacks) to trace, or send spans yourself with an ingest key for{" "}
            <span className="font-mono">{project?.slug ?? "your project"}</span>.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to={`${awsAccountsLink(workspace)}?connect=1`}>
                <Cloud className="mr-2 size-4" />
                Connect AWS account
              </Link>
            </Button>
            <Button variant="outline" onClick={() => void newKey()} disabled={busy || !project || !!key}>
              <KeyRound className="mr-2 size-4" />
              Copy an ingest key
            </Button>
          </div>
          {key && <KeyReveal created={key} />}
        </div>
      </Step>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
