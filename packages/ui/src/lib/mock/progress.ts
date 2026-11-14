import { IMPORT_FUNCTION } from "./import.ts";
import { INVOCATIONS, type MockInvocation } from "./fixtures.ts";

/** While live mode polls, a new invocation arrives this often. */
export const LIVE_EVERY_MS = 4000;
/** Every third live invocation runs this long, showing "Running…" until it completes. */
const LONG_RUN_MS = 9000;
/** The long-running import finishes this long after live mode starts. */
const RUNNING_COMPLETES_AFTER_MS = 20_000;
const TIMEOUT_MS = 15 * 60_000;
const MAX_LIVE_ROWS = 300;

const iso = (ms: number) => new Date(ms).toISOString();
const traceIdAt = (ms: number, n: number) => Math.floor(ms / 1000).toString(16).padStart(8, "0") + n.toString(16).padStart(24, "0");
const requestId = (n: number) => `00000000-0000-4000-a000-${n.toString(16).padStart(12, "0")}`;

function running(sample: MockInvocation, n: number, startMs: number, deadlineMs: number, lastSeenMs: number): MockInvocation {
  return {
    ...sample,
    trace_id: traceIdAt(startMs, n),
    span_id: `fe${n.toString(16).padStart(14, "0")}`,
    request_id: requestId(n),
    ts: iso(startMs),
    status: "in_progress",
    duration_ms: lastSeenMs - startMs,
    http_status: null,
    error_type: null,
    error_message: null,
    memory_used_mb: null,
    failure_phase: null,
    failure_kind: null,
    synthetic: false,
    deadline: iso(deadlineMs),
    last_seen: iso(lastSeenMs),
  };
}

function completed(row: MockInvocation, durationMs: number): MockInvocation {
  const { deadline: _d, last_seen: _l, ...rest } = row;
  const sample = INVOCATIONS.find((i) => i.function === row.function && i.status === "ok");
  return { ...rest, status: "ok", duration_ms: durationMs, http_status: sample?.http_status ?? null, memory_used_mb: sample?.memory_used_mb ?? 120 };
}

/**
 * Long-running invocations around the time the mock started: an import still running (it completes 20 s after
 * live mode starts) and a queue run past its deadline with no completion recorded.
 */
export function progressRows(createdMs: number, liveStart: number | null, now: number): MockInvocation[] {
  const importSample = INVOCATIONS.find((i) => i.function === IMPORT_FUNCTION) ?? INVOCATIONS[0];
  const queueSample = INVOCATIONS.find((i) => i.function === "orders-processQueue" && i.status === "ok") ?? INVOCATIONS[0];
  const importStart = createdMs - 134_000;
  const done = liveStart !== null && now >= liveStart + RUNNING_COMPLETES_AFTER_MS;
  const importRow = running(importSample, 1, importStart, importStart + TIMEOUT_MS, Math.min(now, importStart + TIMEOUT_MS));
  const stalledStart = createdMs - 50 * 60_000;
  const stalled = running(queueSample, 2, stalledStart, stalledStart + TIMEOUT_MS, stalledStart + 14 * 60_000);
  return [done ? completed(importRow, (liveStart ?? now) + RUNNING_COMPLETES_AFTER_MS - importStart) : importRow, stalled];
}

/** Invocations that "arrive" every few seconds once live mode started polling. */
export function liveRows(liveStart: number | null, now: number): MockInvocation[] {
  if (liveStart === null) return [];
  const samples = INVOCATIONS.filter((i) => i.status === "ok" && !i.cold_start && i.function !== IMPORT_FUNCTION && i.function !== "support-answerTicket").slice(0, 24);
  const count = Math.min(Math.floor((now - liveStart) / LIVE_EVERY_MS), MAX_LIVE_ROWS);
  const out: MockInvocation[] = [];
  for (let k = 1; k <= count; k++) {
    const sample = samples[k % samples.length];
    const start = liveStart + k * LIVE_EVERY_MS;
    const n = 0x100 + k;
    if (k % 3 === 0) {
      const row = running(sample, n, start, start + 60_000, now);
      out.push(now < start + LONG_RUN_MS ? row : completed(row, LONG_RUN_MS + 123));
    } else {
      out.push({ ...sample, trace_id: traceIdAt(start, n), span_id: `fe${n.toString(16).padStart(14, "0")}`, request_id: requestId(n), ts: iso(start) });
    }
  }
  return out;
}
