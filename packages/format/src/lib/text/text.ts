/** Milliseconds as a short string: one decimal below 100 ms, whole numbers above. */
export function ms(value: number): string {
  if (!Number.isFinite(value)) return "?";
  return Math.abs(value) < 100 ? `${value.toFixed(1)}ms` : `${Math.round(value)}ms`;
}

export function signedMs(value: number): string {
  return `${value >= 0 ? "+" : "-"}${ms(Math.abs(value))}`;
}

/** Collapses whitespace and cuts to `max` characters with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(max - 1, 0))}…` : flat;
}

/** ISO timestamp without milliseconds, e.g. `2026-11-14T12:00:01Z`. */
export function shortIso(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z");
}

/** Rough token estimate (about four characters per token for this kind of text). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
