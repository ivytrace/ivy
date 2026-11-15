import { CUT_KEY, CUT_VALUE, parsePayload } from "@ivy/spans";
import { oneLine } from "../text/text.js";

const SOURCE_TRUNCATION = /…\[truncated (\d+) bytes\]$/;
const CUT_ITEM = JSON.stringify(CUT_VALUE);
const CUT_ENTRY = `${JSON.stringify(CUT_KEY)}:${CUT_ITEM}`;
const MAX_STRING = 120;
const MAX_ITEMS = 5;
const MAX_DEPTH = 5;

/**
 * Shrinks a parsed JSON value structurally (long strings, long arrays, deep nesting) so that a
 * character cut afterwards still shows the shape. Keys and `[redacted]` markers are never touched.
 */
export function shrink(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => shrink(v, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`…+${value.length - MAX_ITEMS} more`);
    return items;
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, depth + 1)]));
}

/**
 * Renders a stored payload attribute (`ivy.payload.*`) as one line of at most `budget` characters.
 * Redaction happened at the source; this only shortens. Returns undefined for empty payloads.
 */
export function trimPayload(raw: string | undefined, budget: number): string | undefined {
  if (raw === undefined || raw === "" || budget <= 0) return undefined;
  const sourceCut = SOURCE_TRUNCATION.exec(raw);
  const value = parsePayload(raw);
  if (value === undefined) return undefined;

  let text =
    typeof value === "string"
      ? oneLine(value.replace(SOURCE_TRUNCATION, ""), Number.MAX_SAFE_INTEGER)
      : JSON.stringify(shrink(value));
  if (sourceCut) text = text.replaceAll(CUT_ENTRY, "…").replaceAll(CUT_ITEM, "…");
  if (text === "{}" || text === '""') return text;
  if (text.length > budget) text = `${text.slice(0, budget)}…(+${text.length - budget} chars)`;
  if (sourceCut) text += ` [cut at source, ${sourceCut[1]} bytes dropped]`;
  return text;
}
