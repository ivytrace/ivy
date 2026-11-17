import type { QueryResult } from "@ivy/spans";

export const MAX_CELL_CHARS = 200;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = text.replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t").replace(/\|/g, "\\|");
  return flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS)}…` : flat;
}

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/** A query result as text: a summary line, the column names, then one line per row, cells separated by ` | `. */
export function formatQueryResult(result: QueryResult): string {
  const { rows_read, elapsed_ms } = result.stats;
  const head = `${plural(result.rows.length, "row")}${result.truncated ? " (truncated: add a LIMIT or aggregate)" : ""}, read ${plural(rows_read, "row")} in ${elapsed_ms} ms`;
  if (!result.columns.length) return head;
  const lines = [result.columns.map((c) => c.name).join(" | "), ...result.rows.map((row) => row.map(cell).join(" | "))];
  return `${head}\n${lines.join("\n")}`;
}
