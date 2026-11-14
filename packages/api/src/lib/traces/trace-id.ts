const MIN_TS = Date.parse('2015-01-01T00:00:00Z') / 1000;
const FUTURE_SLACK_S = 86_400;

export function isTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

/** Unix seconds encoded in the first 8 hex chars, or undefined if it doesn't look like a timestamp. */
export function traceIdTimestamp(traceId: string, nowMs = Date.now()): number | undefined {
  const seconds = Number.parseInt(traceId.slice(0, 8), 16);
  if (!Number.isFinite(seconds) || seconds < MIN_TS || seconds > nowMs / 1000 + FUTURE_SLACK_S) return undefined;
  return seconds;
}
