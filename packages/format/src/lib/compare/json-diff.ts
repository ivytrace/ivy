import { shrink } from "../payload/trim.js";

export interface PathDiff {
  path: string;
  a: unknown;
  b: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const kind = (v: unknown) => (v === undefined ? "absent" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * Differences between two JSON values as paths. With `valuesToo` false only structural changes count
 * (a key present on one side only, a type change, an array length change), which skips IDs and
 * timestamps that differ between any two invocations.
 */
export function diffJson(a: unknown, b: unknown, valuesToo: boolean, limit = 6): PathDiff[] {
  const out: PathDiff[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (out.length >= limit) return;
    if (isRecord(x) && isRecord(y)) {
      for (const key of [...new Set([...Object.keys(x), ...Object.keys(y)])]) walk(x[key], y[key], path ? `${path}.${key}` : key);
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) {
        out.push({ path: `${path}.length`, a: x.length, b: y.length });
        return;
      }
      for (let i = 0; i < Math.min(x.length, 5); i++) walk(x[i], y[i], `${path}[${i}]`);
      return;
    }
    if (kind(x) !== kind(y)) out.push({ path, a: x, b: y });
    else if (valuesToo && JSON.stringify(x) !== JSON.stringify(y)) out.push({ path, a: x, b: y });
  };
  walk(a, b, "");
  return out;
}

export function showValue(v: unknown, max = 80): string {
  if (v === undefined) return "(absent)";
  const text = JSON.stringify(shrink(v)) ?? String(v);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
