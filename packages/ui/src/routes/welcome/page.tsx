import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { CheckCircle2, Loader2, Radio } from "lucide-react";

import { Deploy, Details } from "@/components/aws/connect-dialog";
import { FunctionPicker } from "@/components/aws/function-picker";
import { LoadingState } from "@/components/common/states";
import { KeyReveal } from "@/components/workspaces/key-reveal";
import { errorMessage } from "@/components/workspaces/name-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { refreshAws } from "@/lib/api/aws";
import { useAwsAccount, useAwsAccountFunctions, useInvocations, useMultiWorkspace, useProjects, useWorkspaceInfo } from "@/lib/api/hooks";
import type { CreatedKey } from "@/lib/api/types";
import { createKey, createProject, refreshWorkspace, updateWorkspace } from "@/lib/api/workspaces";
import { rememberTraceProject } from "@/lib/aws/last-project";
import { useAuth } from "@/lib/auth/provider";
import { ALL_PROJECTS, pageLink, traceLink } from "@/lib/links/links";
import { ScopeProvider } from "@/lib/links/use-scope";
import { cn } from "@/lib/utils/cn";
import { firstStep, markWelcomeSeen, suggestWorkspaceName, WELCOME_STEPS, welcomeLink, type WelcomeState, type WelcomeStep } from "@/lib/welcome/welcome";

const LABELS: Record<WelcomeStep, string> = { workspace: "Workspace", project: "Project", aws: "Connect", listen: "First trace" };

/**
 * `/welcome/<step>`: the first-run quick start. Name the workspace and the first project, connect AWS
 * (or copy an ingest key), and wait for the first trace. Skippable; progress is in the URL.
 */
export default function WelcomePage() {
  const { step = "project" } = useParams();
  const [params] = useSearchParams();
  const state: WelcomeState = {
    ws: params.get("ws") ?? "",
    project: params.get("project") ?? undefined,
    account: params.get("account") ?? undefined,
    from: params.get("from") ?? undefined,
    mode: params.get("mode") ?? undefined,
  };
  if (!state.ws) return <Navigate to="/" replace />;
  if (!WELCOME_STEPS.includes(step as WelcomeStep)) return <Navigate to={welcomeLink("project", state)} replace />;
  return (
    <ScopeProvider scope={{ workspace: state.ws, project: state.project ?? null }}>
      <Wizard step={step as WelcomeStep} state={state} />
    </ScopeProvider>
  );
}

function Wizard({ step, state }: { step: WelcomeStep; state: WelcomeState }) {
  const navigate = useNavigate();
  const multi = useMultiWorkspace();
  const projects = useProjects(state.ws);
  const info = useWorkspaceInfo(state.ws);
  // Only owners name the workspace, and not when they just joined it through an invitation.
  const namesWorkspace = firstStep(multi, state.from === "invite") === "workspace" && info.data?.role === "owner";
  const steps = WELCOME_STEPS.filter((s) => s !== "workspace" || namesWorkspace);
  const project = state.project ?? projects.data?.items[0]?.slug;
  const go = (next: WelcomeStep, patch: Partial<WelcomeState> = {}) => navigate(welcomeLink(next, { ...state, ...patch }));
  // Skipping lands on All projects; after the first trace arrived, on the project that received it.
  const finish = (p: string = ALL_PROJECTS) => {
    markWelcomeSeen(state.ws);
    navigate(pageLink({ workspace: state.ws, project: p }, "functions"), { replace: true });
  };

  if (step === "workspace" && info.data && !namesWorkspace) return <Navigate to={welcomeLink("project", state)} replace />;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-16 items-center gap-4 border-b px-6">
        <span className="font-semibold">Ivy</span>
        <ol className="flex flex-1 items-center justify-center gap-2 text-sm">
          {steps.map((s, i) => {
            const index = steps.indexOf(step);
            return (
              <li key={s} className="flex items-center gap-2">
                {i > 0 && <span className="h-px w-6 bg-border" />}
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-xs",
                    i < index && "border-primary/60 text-primary",
                    i === index && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  {i < index ? <CheckCircle2 className="size-3.5" /> : i + 1}
                </span>
                <span className={cn("hidden sm:inline", i === index ? "text-foreground" : "text-muted-foreground")}>{LABELS[s]}</span>
              </li>
            );
          })}
        </ol>
        <Button variant="ghost" size="sm" onClick={() => finish()}>
          Skip
        </Button>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 p-6 md:p-10">
        {step === "workspace" && <WorkspaceStep state={state} onDone={(ws) => go("project", { ws })} />}
        {step === "project" && <ProjectStep state={state} onDone={(p) => go("aws", { project: p })} />}
        {step === "aws" && project && <AwsStep state={{ ...state, project }} go={go} />}
        {step === "listen" && project && <ListenStep workspace={state.ws} project={project} onDone={() => finish(project)} />}
        {(step === "aws" || step === "listen") && !project && <LoadingState />}
      </main>
    </div>
  );
}

function StepHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold">{title}</h1>
      {children && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

function NameForm({
  initialName,
  submitLabel,
  placeholder,
  onSubmit,
}: {
  initialName: string;
  submitLabel: string;
  placeholder?: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setName(initialName), [initialName]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-md gap-4">
      <div className="grid gap-2">
        <Label htmlFor="wz-name">Name</Label>
        <Input id="wz-name" value={name} autoFocus placeholder={placeholder} onChange={(e) => setName(e.target.value)} />
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function WorkspaceStep({ state, onDone }: { state: WelcomeState; onDone: (ws: string) => void }) {
  const { user } = useAuth();
  const info = useWorkspaceInfo(state.ws);
  if (!info.data) return <LoadingState />;
  const suggested = info.data.name.includes("@") || !info.data.name ? suggestWorkspaceName(user?.email, user?.name) : info.data.name;
  return (
    <>
      <StepHeader title="Name your workspace">
        A workspace is where your team works together: members, AWS accounts and projects. You can invite teammates later.
      </StepHeader>
      <NameForm
        initialName={suggested}
        submitLabel="Continue"
        onSubmit={async (name) => {
          const next = await updateWorkspace(state.ws, { name });
          await refreshWorkspace(next.slug);
          onDone(next.slug);
        }}
      />
    </>
  );
}

function ProjectStep({ state, onDone }: { state: WelcomeState; onDone: (project: string) => void }) {
  return (
    <>
      <StepHeader title="Create your first project">
        A project is usually one app in one environment. Environments are separate projects: <span className="font-mono">checkout-prod</span>{" "}
        and <span className="font-mono">checkout-staging</span>, each with its own data and keys.
      </StepHeader>
      <NameForm
        initialName=""
        placeholder="checkout-prod"
        submitLabel="Create project"
        onSubmit={async (name) => {
          const p = await createProject(state.ws, { name });
          rememberTraceProject(state.ws, p.slug);
          await refreshWorkspace(state.ws);
          onDone(p.slug);
        }}
      />
    </>
  );
}

function AwsStep({ state, go }: { state: Required<Pick<WelcomeState, "ws" | "project">> & WelcomeState; go: (step: WelcomeStep, patch?: Partial<WelcomeState>) => void }) {
  if (state.mode === "manual") return <ManualSetup workspace={state.ws} project={state.project} onBack={() => go("aws", { mode: undefined })} onDone={() => go("listen")} />;
  return (
    <>
      <StepHeader title="Connect your AWS account" />
      {state.account ? (
        <ConnectedAccount state={state} onDone={() => go("listen")} />
      ) : (
        <div className="max-w-xl">
          <Details bare onCreated={(a) => go("aws", { account: a.id })} />
        </div>
      )}
      <p className="mt-8 text-sm">
        <Link to={welcomeLink("aws", { ...state, mode: "manual", account: undefined })} className="text-muted-foreground underline hover:text-foreground">
          Not on AWS, or rather set it up by hand?
        </Link>
      </p>
    </>
  );
}

function ConnectedAccount({ state, onDone }: { state: WelcomeState & { project: string }; onDone: () => void }) {
  const account = useAwsAccount(state.account);
  const [connected, setConnected] = useState(false);
  const functions = useAwsAccountFunctions(connected || account.data?.status === "connected" ? state.account : undefined, {
    refreshInterval: account.data?.syncing ? 2000 : 15_000,
  });
  const [error, setError] = useState<string | null>(null);

  if (!account.data) return <LoadingState />;
  const a = account.data;
  if (a.status === "pending" && !connected) {
    return (
      <div className="max-w-xl">
        <Deploy bare account={a} onConnected={() => (setConnected(true), void refreshAws())} />
      </div>
    );
  }
  const traced = functions.data?.groups.reduce((n, g) => n + g.counts.traced, 0) ?? 0;
  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">
        Connected. Pick the CloudFormation stacks (or name patterns) to trace into <span className="font-mono">{state.project}</span>. Each choice is saved
        as a rule, so functions added later are traced too.
      </p>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {!functions.data ? (
        <LoadingState label={a.syncing ? "Listing functions…" : "Loading…"} className="rounded-md border" />
      ) : functions.data.groups.length === 0 ? (
        <LoadingState label="Listing functions…" className="rounded-md border" />
      ) : (
        <FunctionPicker account={a} groups={functions.data.groups} onError={setError} />
      )}
      <div className="mt-6 flex items-center gap-3">
        <Button onClick={onDone} disabled={!traced}>
          Continue
        </Button>
        {!traced && <span className="text-sm text-muted-foreground">Trace at least one stack or function to continue.</span>}
      </div>
    </div>
  );
}

function ManualSetup({ workspace, project, onBack, onDone }: { workspace: string; project: string; onBack: () => void; onDone: () => void }) {
  const [key, setKey] = useState<CreatedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    createKey(workspace, project, "Quick start").then(setKey, (err) => setError(errorMessage(err)));
  }, [workspace, project]);
  return (
    <>
      <StepHeader title="Set it up by hand">
        Use this ingest key for <span className="font-mono">{project}</span>. Spans sent with it land in that project.
      </StepHeader>
      <div className="max-w-2xl">
        {key ? <KeyReveal created={key} lambda /> : error ? <p className="text-sm text-red-400">{error}</p> : <LoadingState />}
      </div>
      <div className="mt-6 flex items-center gap-3">
        <Button onClick={onDone} disabled={!key}>
          Continue
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Connect AWS instead
        </Button>
      </div>
    </>
  );
}

function ListenStep({ workspace, project, onDone }: { workspace: string; project: string; onDone: () => void }) {
  return (
    <ScopeProvider scope={{ workspace, project }}>
      <Listening workspace={workspace} project={project} onDone={onDone} />
    </ScopeProvider>
  );
}

const LAST_HOUR = { since: "1h" as const };

function Listening({ workspace, project, onDone }: { workspace: string; project: string; onDone: () => void }) {
  const { data } = useInvocations(LAST_HOUR, { limit: 1 }, { refreshInterval: (d) => (d?.items.length ? 0 : 3000) });
  const first = data?.items[0];
  if (first) {
    return (
      <div className="max-w-xl rounded-md border border-emerald-400/30 bg-emerald-400/5 p-6">
        <div className="flex items-center gap-2 text-emerald-400">
          <CheckCircle2 className="size-5" />
          <span className="font-medium">Your first trace arrived</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          <span className="font-mono text-foreground">{first.function}</span> ran for {first.duration_ms} ms ({first.status === "ok" ? "succeeded" : "failed"}).
        </p>
        <div className="mt-4 flex gap-2">
          <Button asChild variant="outline">
            <Link to={traceLink({ workspace, project }, first.trace_id, first.span_id)} onClick={() => markWelcomeSeen(workspace)}>
              Open the trace
            </Link>
          </Button>
          <Button onClick={onDone}>Go to Functions</Button>
        </div>
      </div>
    );
  }
  return (
    <>
      <StepHeader title="Listening for the first trace…" />
      <div className="flex max-w-xl items-center gap-3 rounded-md border p-5 text-sm">
        <Radio className="size-5 animate-pulse text-primary" />
        <span>
          Waiting for spans in <span className="font-mono">{project}</span>. This page checks every few seconds.
        </span>
      </div>
      <ul className="mt-6 grid max-w-2xl list-disc gap-2 pl-5 text-sm text-muted-foreground">
        <li>Invoke one of the functions you picked: run a test event in the Lambda console, or use it the way it's normally used.</li>
        <li>
          For an HTTP function: <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-xs">curl -i https://&lt;your-api&gt;/&lt;path&gt;</code>
        </li>
        <li>Traces arrive a few seconds after an invocation ends. Ivy attaches the layer within a minute of picking a function.</li>
      </ul>
    </>
  );
}
