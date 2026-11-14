import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ExternalLink, ScrollText } from "lucide-react";

import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { ColdStart, InvocationStatus } from "@/components/common/status";
import { PayloadPreview } from "@/components/stats/payload-preview";
import { ErrorBlock } from "@/components/trace/error-block";
import { Logs } from "@/components/trace/logs";
import { SpanFields } from "@/components/trace/span-details";
import { TraceGraph } from "@/components/trace/trace-graph";
import { Waterfall } from "@/components/trace/waterfall";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltipped } from "@/components/ui/tooltipped";
import { ApiError } from "@/lib/api/client";
import { useTrace } from "@/lib/api/hooks";
import { invocationsLink } from "@/lib/links/links";
import type { GraphNode } from "@/lib/spans/graph";
import { describeSpan, getException, getLogs, isInvocationSpan } from "@/lib/spans/services";
import { buildWaterfall, filterInvocation, findRootInvocation } from "@/lib/spans/tree";
import type { Span } from "@/lib/spans/types";
import { formatDuration, formatTimestamp } from "@/lib/utils/format";

type Tab = "overview" | "timeline" | "logs";

function ConsoleLinks({ invocation }: { invocation: Span }) {
  const region = invocation.resource["cloud.region"];
  const name = invocation.name;
  const requestId = invocation.attributes["faas.invocation_id"];
  if (!region) return null;
  const lambdaUrl = `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/functions/${encodeURIComponent(name)}?tab=monitoring`;
  const logGroup = encodeURIComponent(encodeURIComponent(`/aws/lambda/${name}`)).replace(/%/g, "$");
  const logsUrl = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${logGroup}/log-events${requestId ? `$3FfilterPattern$3D$2522${requestId}$2522` : ""}`;
  return (
    <div className="hidden gap-2 md:flex">
      <Tooltipped title="Open in AWS Console">
        <Button variant="outline" size="icon" asChild>
          <a href={lambdaUrl} target="_blank" rel="noreferrer" aria-label="Open in AWS Console">
            <ExternalLink className="size-4" />
          </a>
        </Button>
      </Tooltipped>
      <Tooltipped title="Open CloudWatch Logs">
        <Button variant="outline" size="icon" asChild>
          <a href={logsUrl} target="_blank" rel="noreferrer" aria-label="Open CloudWatch Logs">
            <ScrollText className="size-4" />
          </a>
        </Button>
      </Tooltipped>
    </div>
  );
}

function Summary({ invocation, traceId }: { invocation: Span; traceId: string }) {
  const a = invocation.attributes;
  const exception = getException(invocation);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <dl className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <span className="mr-4">
          <InvocationStatus
            ok={invocation.status_code !== "ERROR"}
            errorType={exception?.type}
            errorMessage={exception?.message}
            httpStatus={a["http.response.status_code"]}
          />
        </span>
        <dt className="hidden md:block">Start time</dt>
        <dd className="mr-4 hidden font-semibold text-foreground md:block">{formatTimestamp(invocation.start)}</dd>
        <dt className="hidden md:block">Duration</dt>
        <dd className="mr-4 flex items-center gap-2 font-semibold text-foreground">
          {formatDuration(invocation.duration_ms)}
          {a["faas.coldstart"] === "true" && <ColdStart />}
        </dd>
        {a["ivy.memory_used_mb"] && (
          <>
            <dt className="hidden md:block">Memory</dt>
            <dd className="mr-4 hidden font-semibold text-foreground md:block">{a["ivy.memory_used_mb"]} MB</dd>
          </>
        )}
        <dt className="hidden lg:block">Trace</dt>
        <dd className="mr-4 hidden font-mono text-xs font-semibold text-foreground lg:block">{traceId}</dd>
      </dl>
      <ConsoleLinks invocation={invocation} />
    </div>
  );
}

function Overview({ invocation }: { invocation: Span }) {
  const d = describeSpan(invocation);
  const exception = getException(invocation);
  return (
    <div className="flex flex-col gap-6">
      {exception && (
        <section>
          <h4 className="mb-3 text-sm font-medium">Error</h4>
          <ErrorBlock exception={exception} />
        </section>
      )}
      <section>
        <h4 className="mb-3 text-sm font-medium">Invocation</h4>
        <SpanFields span={invocation} />
      </section>
      <PayloadPreview title="Event payload" value={d.request} truncated={d.truncated} />
      <PayloadPreview title="Return value" value={d.response} truncated={d.truncated} />
      <PayloadPreview title="Resource" value={invocation.resource} defaultOpen={false} />
    </div>
  );
}

function TraceView({ traceId, spans }: { traceId: string; spans: Span[] }) {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>("overview");
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [filterCurrent, setFilterCurrent] = useState(true);

  const invocations = spans.filter(isInvocationSpan);
  const invocation =
    invocations.find((s) => s.span_id === params.get("invocation")) ?? findRootInvocation(spans) ?? spans[0];

  const filtering = filterCurrent && invocations.length > 1 && isInvocationSpan(invocation);
  const { rows, totalMs } = useMemo(() => {
    const all = buildWaterfall(spans);
    if (!filtering) return all;
    return buildWaterfall(filterInvocation(all.rows, invocation.span_id).map((r) => r.span));
  }, [spans, filtering, invocation.span_id]);
  const visibleSpans = useMemo(() => rows.map((r) => r.span), [rows]);
  const visibleIds = new Set(visibleSpans.map((s) => s.span_id));
  const logs = getLogs(spans).filter((l) => visibleIds.has(l.spanId));

  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const focusNode = (node: GraphNode) => {
    if (node.isTrigger) {
      setTab("overview");
      return;
    }
    const invocationNode = node.spanIds.map((id) => invocations.find((s) => s.span_id === id)).find(Boolean);
    if (invocationNode && invocationNode.span_id !== invocation.span_id) {
      setParams({ invocation: invocationNode.span_id }, { replace: true });
    }
    setTab("timeline");
    setOpenIds(new Set(node.spanIds.length === 1 ? node.spanIds : []));
    requestAnimationFrame(() => {
      const el = document.getElementById(`span-${node.spanIds[0]}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.classList.add("bg-muted");
      setTimeout(() => el?.classList.remove("bg-muted"), 1000);
    });
  };

  return (
    <>
      <div className="border-b px-6 py-5 md:px-8">
        <Button variant="link" className="h-auto px-0" asChild>
          <Link to={invocationsLink({ function: invocation.name })}>← {invocation.name}</Link>
        </Button>
        <h1 className="truncate text-2xl font-bold">
          {invocation.attributes["faas.invocation_id"] ?? invocation.name}
        </h1>
        <Summary invocation={invocation} traceId={traceId} />
      </div>

      <div className="h-full flex-1 overflow-hidden md:flex">
        <div className="relative h-[300px] overflow-hidden border-b md:h-full md:w-1/3 md:border-b-0 md:border-r">
          <TraceGraph spans={visibleSpans} onSelect={focusNode} />
        </div>

        <div className="flex-1 p-6 md:h-full md:overflow-auto md:px-10 md:py-8">
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="timeline">Timeline ({rows.length})</TabsTrigger>
                <TabsTrigger value="logs">Logs ({logs.length})</TabsTrigger>
              </TabsList>
              {invocations.length > 1 && (
                <div className="flex items-center gap-2">
                  <Switch id="filter-current" checked={filterCurrent} onCheckedChange={setFilterCurrent} />
                  <Label htmlFor="filter-current" className="text-xs text-muted-foreground">
                    Only this invocation ({invocations.length} in trace)
                  </Label>
                </div>
              )}
            </div>
            <TabsContent value="overview">
              <Overview invocation={invocation} />
            </TabsContent>
            <TabsContent value="timeline">
              <Waterfall rows={rows} totalMs={totalMs} openIds={openIds} onToggle={toggle} />
            </TabsContent>
            <TabsContent value="logs">
              <Logs logs={logs} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  );
}

export default function TraceDetails() {
  const { traceId = "" } = useParams();
  const { data, error, mutate } = useTrace(traceId);

  if (error) {
    return error instanceof ApiError && error.status === 404 ? (
      <EmptyState
        className="flex-1"
        title="Trace not found"
        description={`No spans found for trace ${traceId}. It may not have been ingested yet, or it has expired.`}
      />
    ) : (
      <ErrorState className="flex-1" error={error} onRetry={() => void mutate()} />
    );
  }
  if (!data) return <LoadingState className="flex-1" label="Loading trace…" />;
  if (!data.spans.length) return <EmptyState className="flex-1" title="Empty trace" />;
  return <TraceView traceId={data.trace_id} spans={data.spans} />;
}
