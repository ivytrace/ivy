import { Link } from "react-router";
import { templateParts } from "@ivy/spans";

import type { ErrorGroup } from "@/lib/api/types";
import { traceLink, type Scope } from "@/lib/links/links";
import { formatAgo, formatNumber } from "@/lib/utils/format";

/** An error group's message template, placeholders (`{path}`, `{id}`, …) muted. */
export function ErrorTemplate({ template, className }: { template: string; className?: string }) {
  return (
    <span className={className}>
      {templateParts(template).map((part, i) =>
        part.placeholder ? (
          <span key={i} className="font-mono text-[0.9em] text-zinc-500">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}

export const variantsLabel = (n: number) => `${formatNumber(n)} ${n === 1 ? "variant" : "variants"}`;

/** The most frequent raw messages of a group, each with its count and latest trace. */
export function GroupMessages({ group, scope }: { group: ErrorGroup; scope: Scope }) {
  const shown = group.top_messages;
  return (
    <div className="rounded-md border bg-zinc-950/40">
      <ul className="divide-y text-sm">
        {shown.map((m) => (
          <li key={m.message} className="flex items-center gap-3 px-3 py-1.5">
            <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{formatNumber(m.count)}×</span>
            <Link
              to={traceLink(scope, m.sample_trace_id)}
              className="min-w-0 flex-1 truncate font-mono text-xs text-foreground hover:text-primary hover:underline"
              title={m.message}
            >
              {m.message}
            </Link>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{formatAgo(m.last_seen)}</span>
          </li>
        ))}
      </ul>
      {group.variants > shown.length && (
        <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
          The {shown.length} most frequent of {variantsLabel(group.variants)}.
        </p>
      )}
    </div>
  );
}
