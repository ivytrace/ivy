import type { Completion } from "@codemirror/autocomplete";
import { QUERY_TABLES, type QueryColumn } from "@ivy/spans";
import { FUNCTIONS } from "./clickhouse";

const TABLE_REF = /\b(?:from|join)\s+(\w+)/gi;

/** The Query page's tables the SQL reads (FROM / JOIN), in the order they appear. */
export function referencedTables(sql: string): string[] {
  const names = new Set(QUERY_TABLES.map((t) => t.name));
  return [...new Set([...sql.matchAll(TABLE_REF)].map((m) => m[1].toLowerCase()).filter((n) => names.has(n)))];
}

const columnCompletion = (table: string, c: QueryColumn, boost: number): Completion => ({
  label: c.name,
  type: "property",
  detail: c.type,
  info: `${table}: ${c.description}`,
  boost,
});

/**
 * What to offer for the word at the cursor: after `table.`, that table's columns; otherwise the columns of the
 * tables the query reads (all tables' columns when it reads none yet), the tables, and functions.
 */
export function completionsFor(sql: string, qualifier: string | null): Completion[] {
  if (qualifier !== null) {
    const table = QUERY_TABLES.find((t) => t.name === qualifier.toLowerCase());
    return table ? table.columns.map((c) => columnCompletion(table.name, c, 3)) : [];
  }
  const used = referencedTables(sql);
  const tables = used.length ? QUERY_TABLES.filter((t) => used.includes(t.name)) : QUERY_TABLES;
  const seen = new Set<string>();
  const columns = tables.flatMap((t) =>
    t.columns.filter((c) => !seen.has(c.name) && seen.add(c.name)).map((c) => columnCompletion(t.name, c, 3)),
  );
  const tableOptions = QUERY_TABLES.map((t): Completion => ({ label: t.name, type: "class", info: t.description, boost: 2 }));
  const functions = FUNCTIONS.map((f): Completion => ({ label: f.name, type: "function", detail: f.detail, boost: 1 }));
  return [...columns, ...tableOptions, ...functions];
}
