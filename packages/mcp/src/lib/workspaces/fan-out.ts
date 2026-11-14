import type { Workspace } from "../data/types.js";

export interface FanOutOptions {
  /** Workspaces queried at the same time (default 4). */
  concurrency?: number;
  /** Per-workspace time limit in ms (default 10 s). The query is abandoned, not cancelled; ClickHouse has its own limit. */
  timeoutMs?: number;
}

export interface FanOutResult<W, T> {
  ok: { workspace: W; value: T }[];
  failed: { workspace: W; error: string }[];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs `run` once per workspace with bounded concurrency and a per-workspace timeout. Never one
 * cross-tenant query: each call is a normal tenant-scoped read. Failures are collected, not thrown,
 * so one broken workspace doesn't hide the others. Results keep the order of `workspaces`.
 */
export async function fanOut<W extends Workspace, T>(
  workspaces: W[],
  run: (workspace: W) => Promise<T>,
  options: FanOutOptions = {},
): Promise<FanOutResult<W, T>> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const settled: ({ value: T } | { error: string })[] = new Array(workspaces.length);
  let next = 0;
  const worker = async () => {
    while (next < workspaces.length) {
      const i = next++;
      try {
        settled[i] = { value: await withTimeout(run(workspaces[i]), timeoutMs) };
      } catch (err) {
        settled[i] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, workspaces.length) }, worker));

  const result: FanOutResult<W, T> = { ok: [], failed: [] };
  settled.forEach((s, i) => {
    if ("value" in s) result.ok.push({ workspace: workspaces[i], value: s.value });
    else result.failed.push({ workspace: workspaces[i], error: s.error });
  });
  return result;
}

/** Note appended to answers when some workspaces could not be read. */
export function failureNote(failed: { workspace: Workspace; error: string }[]): string {
  if (!failed.length) return "";
  return `\n\nNot included (query failed): ${failed.map((f) => `${f.workspace.slug} (${f.error})`).join("; ")}`;
}

/** First workspace for which `find` returns a value, trying them with bounded concurrency. */
export async function findFirst<W extends Workspace, T>(
  workspaces: W[],
  find: (workspace: W) => Promise<T | null>,
  options: FanOutOptions = {},
): Promise<{ hit: { workspace: W; value: T } | null; failed: FanOutResult<W, T | null>["failed"] }> {
  const result = await fanOut(workspaces, find, options);
  const hit = result.ok.find((r) => r.value !== null) as { workspace: W; value: T } | undefined;
  return { hit: hit ?? null, failed: result.failed };
}
