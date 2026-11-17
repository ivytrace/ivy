import { controlClient } from '../clickhouse/client.js';
import { insertRows, tenantQuery } from '../clickhouse/scoped.js';

/** A query saved on the Query page, shared by the workspace's members. */
export interface SavedQuery {
  tenant_id: string;
  id: string;
  name: string;
  sql: string;
  /** Email of who created / last changed it ('' with auth off). */
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
  deleted: boolean;
}

export interface SavedQueryStore {
  /** Every saved query of the workspace, deleted ones included (they keep a default from coming back). */
  list(tenant: string): Promise<SavedQuery[]>;
  save(queries: SavedQuery[]): Promise<void>;
}

const iso = (ms: number) => new Date(ms).toISOString();

const COLUMNS = `tenant_id, id, name, sql, created_by, toUnixTimestamp64Milli(created_at) AS created_at, updated_by,
  toUnixTimestamp64Milli(updated_at) AS updated_at, deleted = 1 AS deleted`;

export const clickhouseSavedQueryStore: SavedQueryStore = {
  list: async (tenant) =>
    (
      await tenantQuery<SavedQuery>(
        controlClient(),
        tenant,
        `SELECT ${COLUMNS} FROM saved_queries FINAL WHERE tenant_id = {tenant:String} ORDER BY created_at, id`,
      )
    ).map((q) => ({ ...q, deleted: !!q.deleted })),
  save: (queries) =>
    insertRows(
      controlClient(),
      'saved_queries',
      queries.map((q) => ({ ...q, created_at: iso(q.created_at), updated_at: iso(q.updated_at), deleted: q.deleted ? 1 : 0 })),
    ),
};

/** In-memory SavedQueryStore with the same semantics. Used by tests. */
export function memorySavedQueryStore(): SavedQueryStore {
  const rows = new Map<string, SavedQuery>();
  return {
    async list(tenant) {
      return [...rows.values()]
        .filter((q) => q.tenant_id === tenant)
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
        .map((q) => structuredClone(q));
    },
    async save(queries) {
      for (const q of queries) rows.set(`${q.tenant_id}/${q.id}`, structuredClone(q));
    },
  };
}

let current: SavedQueryStore = clickhouseSavedQueryStore;
export const savedQueryStore = () => current;
export function setSavedQueryStore(store: SavedQueryStore) {
  current = store;
}
