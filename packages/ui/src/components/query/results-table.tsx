import { Link } from "react-router";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useProjects } from "@/lib/api/hooks";
import type { QueryResponse } from "@/lib/api/query";
import { traceLink, type Scope } from "@/lib/links/links";
import { formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

const NUMERIC = /^(Nullable\()?(LowCardinality\()?(U?Int\d+|Float\d+|Decimal)/;
const TRACE_ID = /^[0-9a-f]{32}$/i;

const text = (value: unknown) => (value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));

export function toCsv(result: QueryResponse): string {
  const quote = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [result.columns.map((c) => quote(c.name)), ...result.rows.map((row) => row.map((v) => quote(text(v))))].map((r) => r.join(",")).join("\n");
}

function downloadCsv(result: QueryResponse) {
  const href = URL.createObjectURL(new Blob([toCsv(result)], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href, download: `ivy-query-${new Date().toISOString().slice(0, 16).replace(":", "")}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function Cell({ value, numeric, trace }: { value: unknown; numeric: boolean; trace?: string }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">NULL</span>;
  if (trace) {
    return (
      <Link to={trace} className="link font-mono text-xs font-normal">
        {String(value)}
      </Link>
    );
  }
  const shown = text(value);
  if (numeric) return <span className="tabular-nums">{shown}</span>;
  return (
    <span className={cn("block max-w-[32rem] truncate", typeof value === "object" && "font-mono text-xs")} title={shown.length > 60 ? shown : undefined}>
      {shown}
    </span>
  );
}

/** A query result: one column per result column (name and ClickHouse type), trace IDs linking to their trace. */
export function ResultsTable({ result, scope }: { result: QueryResponse; scope: Scope }) {
  const projects = useProjects(scope.workspace);
  const slugs = new Map(projects.data?.items.map((p) => [p.id, p.slug]));
  const traceColumn = result.columns.findIndex((c) => c.name === "trace_id");
  const projectColumn = result.columns.findIndex((c) => c.name === "project_id");
  const numeric = result.columns.map((c) => NUMERIC.test(c.type));

  const traceHref = (row: unknown[]) => {
    const id = row[traceColumn];
    if (typeof id !== "string" || !TRACE_ID.test(id)) return undefined;
    const project = projectColumn >= 0 ? slugs.get(String(row[projectColumn])) : undefined;
    return traceLink({ workspace: scope.workspace, project: project ?? scope.project }, id);
  };

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground">
        <span>
          <span className="text-foreground">{formatNumber(result.rows.length)}</span> {result.rows.length === 1 ? "row" : "rows"}
          {result.truncated && " (more rows were cut off: add a LIMIT or aggregate)"}
        </span>
        <span>
          read {formatNumber(result.stats.rows_read)} rows in {formatNumber(result.stats.elapsed_ms)} ms
        </span>
        {result.rows.length > 0 && (
          <Button variant="ghost" size="sm" className="ml-auto h-7 px-2" onClick={() => downloadCsv(result)}>
            <Download className="mr-1.5 size-3.5" />
            CSV
          </Button>
        )}
      </div>
      {result.rows.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">No rows.</p>
      ) : (
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b">
                {result.columns.map((c, i) => (
                  <th key={i} className={cn("whitespace-nowrap px-3 py-2 text-left align-bottom font-medium", numeric[i] && "text-right")}>
                    {c.name}
                    <span className="block text-[11px] font-normal text-muted-foreground">{c.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, r) => {
                const trace = traceColumn >= 0 ? traceHref(row) : undefined;
                return (
                  <tr key={r} className="border-b last:border-0 hover:bg-muted/40">
                    {row.map((value, i) => (
                      <td key={i} className={cn("whitespace-nowrap px-3 py-1.5", numeric[i] && "text-right")}>
                        <Cell value={value} numeric={numeric[i]} trace={i === traceColumn ? trace : undefined} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
