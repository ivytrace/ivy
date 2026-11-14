import type { Trace } from "@ivy/spans";
import type { IvyData, Workspace } from "../data/types.js";
import { fanOut, findFirst, type FanOutOptions } from "./fan-out.js";

export class ToolInputError extends Error {}

/**
 * The workspaces a call covers: the one named by `workspace` (ID or slug, case-insensitive), or all
 * of the caller's. A future `project` filter narrows within these.
 */
export async function selectWorkspaces<W extends Workspace>(data: IvyData<W>, workspace: string | undefined): Promise<W[]> {
  const all = await data.workspaces();
  if (!workspace) {
    if (!all.length) throw new ToolInputError("You are not a member of any workspace.");
    return all;
  }
  const wanted = workspace.toLowerCase();
  const match = all.find((w) => w.id.toLowerCase() === wanted || w.slug.toLowerCase() === wanted);
  if (!match) {
    throw new ToolInputError(`Unknown workspace "${workspace}". Yours: ${all.map((w) => w.slug).join(", ") || "none"} (see list_workspaces).`);
  }
  return [match];
}

/** Seconds timestamp in the first 8 hex chars of Ivy trace IDs (span-conventions.md), if plausible. */
export function traceIdTime(traceId: string): number | undefined {
  const seconds = Number.parseInt(traceId.slice(0, 8), 16);
  const ms = seconds * 1000;
  return ms > Date.UTC(2020, 0, 1) && ms < Date.now() + 86_400_000 ? ms : undefined;
}

const HOUR = 3_600_000;

/**
 * Finds the workspace holding a trace. With several workspaces it first asks each one's invocations
 * table for the trace ID within an hour of the ID's timestamp (cheap: the table is ordered by tenant
 * and time), then loads the trace from the workspace that has it. Traces without an Ivy invocation or
 * without a timestamped ID fall back to loading the trace from each workspace until one has it.
 */
export async function locateTrace<W extends Workspace>(
  data: IvyData<W>,
  workspaces: W[],
  traceId: string,
  options?: FanOutOptions,
): Promise<{ hit: { workspace: W; trace: Trace } | null; failed: { workspace: W; error: string }[] }> {
  const id = traceId.toLowerCase();
  let candidates = workspaces;
  const failed: { workspace: W; error: string }[] = [];

  const at = traceIdTime(id);
  if (workspaces.length > 1 && at !== undefined) {
    const probe = await fanOut(
      workspaces,
      (w) => data.invocations(w, { q: id, from: new Date(at - HOUR).toISOString(), to: new Date(at + HOUR).toISOString(), limit: 1 }),
      options,
    );
    failed.push(...probe.failed);
    const holders = probe.ok.filter((r) => r.value.length > 0).map((r) => r.workspace);
    if (holders.length) candidates = holders;
    else candidates = probe.ok.map((r) => r.workspace);
  }

  const found = await findFirst(candidates, (w) => data.trace(w, id), options);
  failed.push(...found.failed);
  return { hit: found.hit && { workspace: found.hit.workspace, trace: found.hit.value }, failed };
}
