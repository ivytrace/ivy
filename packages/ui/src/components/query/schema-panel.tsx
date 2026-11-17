import { ChevronRight } from "lucide-react";
import { QUERY_TABLES } from "@ivy/spans";

/** The Query views and their columns; clicking a name inserts it into the editor. */
export function SchemaPanel({ onInsert }: { onInsert: (text: string) => void }) {
  return (
    <div className="space-y-1">
      {QUERY_TABLES.map((table) => (
        <details key={table.name} className="group">
          <summary className="flex cursor-pointer items-center gap-1 rounded px-1 py-1 text-sm hover:bg-accent">
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
            <span className="font-mono">{table.name}</span>
          </summary>
          <p className="px-1 pb-1 pl-6 text-xs text-muted-foreground">{table.description}</p>
          <ul className="pb-2 pl-5">
            <li>
              <button type="button" onClick={() => onInsert(table.name)} className="px-1 text-xs text-muted-foreground hover:text-foreground">
                Insert table name
              </button>
            </li>
            {table.columns.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  title={c.description}
                  onClick={() => onInsert(c.name)}
                  className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-accent"
                >
                  <span className="truncate font-mono text-xs">{c.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{c.type}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
