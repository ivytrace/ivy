import { useEffect, useState, type ReactNode } from "react";
import type { App, McpUiDisplayMode, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { Maximize2, Minimize2 } from "lucide-react";

import { ColdStart, InvocationStatus, MemoryUsage } from "@/components/common/status";
import { ErrorBlock } from "@/components/trace/error-block";
import { FailureNote } from "@/components/trace/failure-note";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Tooltipped } from "@/components/ui/tooltipped";
import { getException, invocationResources, spanFailureKind } from "@/lib/spans/services";
import { findRootInvocation } from "@/lib/spans/tree";
import type { Span, Trace } from "@/lib/spans/types";
import { formatDuration, formatTimestamp } from "@/lib/utils/format";

/** `structuredContent` of render_waterfall / render_graph (packages/mcp/src/lib/apps/views.ts). */
export interface ViewData {
  workspace: { id: string; slug: string; name: string };
  trace: Trace & { omitted_spans?: number };
}

type State =
  | { kind: "connecting" }
  | { kind: "loading"; traceId?: string }
  | { kind: "ready"; data: ViewData }
  | { kind: "error"; message: string };

function isViewData(value: unknown): value is ViewData {
  const v = value as ViewData | undefined;
  return !!v && typeof v === "object" && !!v.trace && Array.isArray(v.trace.spans) && !!v.workspace;
}

/** Connects to the host and turns tool input/result notifications into view state. */
function useViewState(name: string) {
  const [state, setState] = useState<State>({ kind: "connecting" });
  const [context, setContext] = useState<McpUiHostContext | undefined>();

  const { app, error } = useApp({
    appInfo: { name, version: "1.0.0" },
    capabilities: {},
    onAppCreated: (created: App) => {
      created.ontoolinput = (params) => {
        const traceId = typeof params.arguments?.trace_id === "string" ? params.arguments.trace_id : undefined;
        setState((s) => (s.kind === "ready" ? s : { kind: "loading", traceId }));
      };
      created.ontoolresult = (result) => {
        if (isViewData(result.structuredContent)) {
          setState({ kind: "ready", data: result.structuredContent });
          return;
        }
        const text = result.content?.find((c) => c.type === "text");
        setState({ kind: "error", message: text && "text" in text ? text.text : "The tool returned no trace." });
      };
      created.ontoolcancelled = () => setState({ kind: "error", message: "Cancelled." });
      created.onhostcontextchanged = (ctx) => setContext((prev) => ({ ...prev, ...ctx }));
      created.onteardown = async () => ({});
    },
  });

  useEffect(() => {
    if (app) {
      setContext(app.getHostContext());
      setState((s) => (s.kind === "connecting" ? { kind: "loading" } : s));
    }
  }, [app]);

  useEffect(() => {
    const insets = context?.safeAreaInsets;
    if (insets) document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  }, [context?.safeAreaInsets]);

  return { app, state: error ? ({ kind: "error", message: error.message } as State) : state, context };
}

function Header({ data, invocation, actions }: { data: ViewData; invocation: Span; actions: ReactNode }) {
  const a = invocation.attributes;
  const exception = getException(invocation);
  const res = invocationResources(invocation);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground/80">{data.workspace.name}</span>
          <span className="truncate font-mono">{data.trace.trace_id}</span>
        </div>
        <h1 className="mt-1 truncate text-base font-semibold">{invocation.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <InvocationStatus
            ok={invocation.status_code !== "ERROR"}
            errorType={exception?.type}
            errorMessage={exception?.message}
            httpStatus={a["http.response.status_code"]}
            failureKind={spanFailureKind(invocation)}
          />
          <span>{formatTimestamp(invocation.start)}</span>
          <span className="flex items-center gap-2 font-semibold text-foreground">
            {formatDuration(invocation.duration_ms)}
            {a["faas.coldstart"] === "true" && <ColdStart />}
          </span>
          {res.billedDurationMs !== null && <span>billed {formatDuration(res.billedDurationMs)}</span>}
          {res.initDurationMs !== null && <span>init {formatDuration(res.initDurationMs)}</span>}
          {res.memoryUsedMb !== null && <MemoryUsage used={res.memoryUsedMb} limit={res.memoryLimitMb} />}
        </div>
        <FailureNote invocation={invocation} className="mt-2" />
      </div>
      <div className="flex items-center gap-1">{actions}</div>
    </div>
  );
}

/** The invocation's error with its stack (the dashboard shows it on the Overview tab, which views don't have). */
function InvocationError({ invocation }: { invocation: Span }) {
  const exception = invocation.status_code === "ERROR" ? getException(invocation) : undefined;
  if (!exception) return null;
  return (
    <div className="border-b px-4 py-3 [&>div]:max-h-40">
      <ErrorBlock exception={exception} />
    </div>
  );
}

function FullscreenToggle({ app, context }: { app: App; context?: McpUiHostContext }) {
  const modes = context?.availableDisplayModes ?? [];
  if (!modes.includes("fullscreen")) return null;
  const mode: McpUiDisplayMode = context?.displayMode ?? "inline";
  const next: McpUiDisplayMode = mode === "fullscreen" ? "inline" : "fullscreen";
  return (
    <Tooltipped title={mode === "fullscreen" ? "Exit full screen" : "Full screen"}>
      <button
        type="button"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => void app.requestDisplayMode({ mode: next })}
        aria-label={mode === "fullscreen" ? "Exit full screen" : "Full screen"}
      >
        {mode === "fullscreen" ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </button>
    </Tooltipped>
  );
}

function Message({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <div className={tone === "error" ? "px-4 py-10 text-center text-sm text-red-400" : "px-4 py-10 text-center text-sm text-muted-foreground"}>
      {children}
    </div>
  );
}

/**
 * Frame of an Ivy MCP Apps view: connects to the host, shows loading and error states, the trace
 * header (workspace, function, status, duration) and `children` once the tool result arrives.
 * Always dark, like the dashboard.
 */
export function ViewShell({
  name,
  children,
}: {
  name: string;
  children: (data: ViewData, context: { fullscreen: boolean }) => ReactNode;
}) {
  const { app, state, context } = useViewState(name);
  const fullscreen = context?.displayMode === "fullscreen";

  let body: ReactNode;
  if (state.kind === "error") body = <Message tone="error">{state.message}</Message>;
  else if (state.kind !== "ready") body = <Message>{state.kind === "connecting" ? "Connecting…" : "Loading trace…"}</Message>;
  else {
    const { data } = state;
    const invocation = findRootInvocation(data.trace.spans) ?? data.trace.spans[0];
    body = invocation ? (
      <>
        <Header data={data} invocation={invocation} actions={app && <FullscreenToggle app={app} context={context} />} />
        <InvocationError invocation={invocation} />
        {children(data, { fullscreen })}
        {!!data.trace.omitted_spans && (
          <div className="border-t px-4 py-2 text-xs text-muted-foreground">
            {data.trace.omitted_spans} later spans not shown. Open the trace in Ivy for all of them.
          </div>
        )}
      </>
    ) : (
      <Message>This trace has no spans.</Message>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className={fullscreen ? "flex min-h-screen flex-col bg-background text-foreground" : "overflow-hidden rounded-xl border bg-background text-foreground"}>
        {body}
      </div>
    </TooltipProvider>
  );
}
