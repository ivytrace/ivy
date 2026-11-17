import useSWR, { mutate } from "swr";
import type { QueryResult } from "@ivy/spans";
import type { Scope } from "../links/links";
import { buildUrl, fetchJson, rangeParams, sendJson } from "./client";
import { scopePath, wsPath } from "./hooks";
import type { ListResponse, TimeRange } from "./types";

export interface QueryResponse extends QueryResult {
  range: { from: string; to: string };
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

const enc = encodeURIComponent;
const queriesUrl = (workspace: string) => buildUrl(`${wsPath(workspace)}/queries`);

/** Runs SQL over the scope's project (or every project under `all`) and the time range. */
export const runQuery = (scope: Scope, sql: string, range: TimeRange, signal?: AbortSignal) =>
  fetchJson<QueryResponse>(buildUrl(`${scopePath(scope)}/query`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql, ...rangeParams(range) }),
    signal,
  });

export const useSavedQueries = (workspace: string) =>
  useSWR<ListResponse<SavedQuery>>(queriesUrl(workspace), (u: string) => fetchJson<ListResponse<SavedQuery>>(u), { revalidateOnFocus: false });

const refresh = (workspace: string) => mutate(queriesUrl(workspace));

export async function createSavedQuery(workspace: string, body: { name: string; sql: string }) {
  const saved = await sendJson<SavedQuery>("POST", queriesUrl(workspace), body);
  await refresh(workspace);
  return saved;
}

export async function updateSavedQuery(workspace: string, id: string, body: { name?: string; sql?: string }) {
  const saved = await sendJson<SavedQuery>("PATCH", buildUrl(`${wsPath(workspace)}/queries/${enc(id)}`), body);
  await refresh(workspace);
  return saved;
}

export async function deleteSavedQuery(workspace: string, id: string) {
  await sendJson<{ deleted: boolean }>("DELETE", buildUrl(`${wsPath(workspace)}/queries/${enc(id)}`));
  await refresh(workspace);
}
