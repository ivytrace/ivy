import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { Logs } from "@/components/trace/logs";
import { SpanDetails } from "@/components/trace/span-details";
import { Waterfall } from "@/components/trace/waterfall";
import { Tabs, TabsContent, TabsCount, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getLogs, isInvocationSpan } from "@/lib/spans/services";
import { buildWaterfall } from "@/lib/spans/tree";
import type { Span } from "@/lib/spans/types";
import { ViewShell, type ViewData } from "./shell";
import "./view.css";

/** Failed calls start expanded, so the error and its payloads are visible without a click. */
const initiallyOpen = (spans: Span[]) =>
  new Set(spans.filter((s) => s.status_code === "ERROR" && !isInvocationSpan(s)).map((s) => s.span_id).slice(0, 3));

function TraceWaterfall({ data }: { data: ViewData }) {
  const spans = data.trace.spans;
  const { rows, totalMs } = useMemo(() => buildWaterfall(spans), [spans]);
  const logs = useMemo(() => getLogs(spans), [spans]);
  const [openIds, setOpenIds] = useState(() => initiallyOpen(spans));

  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const details = (span: Span) => {
    const own = logs.filter((l) => l.spanId === span.span_id);
    return (
      <div className="flex flex-col gap-3">
        <SpanDetails span={span} />
        {own.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">Logs</h4>
            <Logs logs={own} />
          </section>
        )}
      </div>
    );
  };

  return (
    <Tabs defaultValue="timeline" className="p-4">
      <TabsList className="mb-4">
        <TabsTrigger value="timeline">
          Timeline<TabsCount>{rows.length}</TabsCount>
        </TabsTrigger>
        <TabsTrigger value="logs">
          Logs<TabsCount>{logs.length}</TabsCount>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="timeline">
        <Waterfall rows={rows} totalMs={totalMs} openIds={openIds} onToggle={toggle} details={details} />
      </TabsContent>
      <TabsContent value="logs">
        <Logs logs={logs} />
      </TabsContent>
    </Tabs>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ViewShell name="Ivy waterfall">{(data) => <TraceWaterfall data={data} />}</ViewShell>
  </StrictMode>,
);
