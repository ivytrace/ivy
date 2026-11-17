import { DEFAULT_QUERIES } from '@ivy/spans';
import { HTTPException } from 'hono/http-exception';
import { randomBase62 } from '../tenancy/ids.js';
import { badRequest } from '../utils/http-error.js';
import { savedQueryStore, type SavedQuery } from './store.js';

export const MAX_NAME_LENGTH = 100;
export const MAX_SQL_LENGTH = 100_000;

const newQueryId = () => `qry_${randomBase62(21)}`;
export const defaultQueryId = (key: string) => `qry_default_${key}`;

let lastVersion = 0;
const version = () => (lastVersion = Math.max(Date.now(), lastVersion + 1));

/**
 * Saves the default queries the workspace has never had: each once, so editing or deleting one sticks, and a
 * default added later still reaches existing workspaces. Their IDs are derived, so concurrent calls write the same rows.
 */
async function withDefaults(tenant: string, rows: SavedQuery[]): Promise<SavedQuery[]> {
  const known = new Set(rows.map((q) => q.id));
  const now = version();
  const missing = DEFAULT_QUERIES.filter((d) => !known.has(defaultQueryId(d.key))).map(
    (d, i): SavedQuery => ({
      tenant_id: tenant,
      id: defaultQueryId(d.key),
      name: d.name,
      sql: d.sql,
      created_by: '',
      created_at: now + i,
      updated_by: '',
      updated_at: now + i,
      deleted: false,
    }),
  );
  if (!missing.length) return rows;
  await savedQueryStore().save(missing);
  lastVersion = Math.max(lastVersion, now + missing.length);
  return [...rows, ...missing];
}

export async function listSavedQueries(tenant: string): Promise<SavedQuery[]> {
  const rows = await withDefaults(tenant, await savedQueryStore().list(tenant));
  return rows.filter((q) => !q.deleted).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

async function findSavedQuery(tenant: string, id: string): Promise<SavedQuery> {
  const query = (await listSavedQueries(tenant)).find((q) => q.id === id);
  if (!query) throw new HTTPException(404, { message: 'Saved query not found' });
  return query;
}

function field(body: Record<string, unknown>, key: 'name' | 'sql', max: number, required: boolean): string | undefined {
  const value = body[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${key} is required`);
  const text = key === 'name' ? value.trim() : value;
  if (text.length > max) throw badRequest(`${key} is longer than ${max} characters`);
  return text;
}

export async function createSavedQuery(tenant: string, body: Record<string, unknown>, by: string): Promise<SavedQuery> {
  // The defaults first, so they stay at the top of the list.
  await listSavedQueries(tenant);
  const now = version();
  const query: SavedQuery = {
    tenant_id: tenant,
    id: newQueryId(),
    name: field(body, 'name', MAX_NAME_LENGTH, true)!,
    sql: field(body, 'sql', MAX_SQL_LENGTH, true)!,
    created_by: by,
    created_at: now,
    updated_by: by,
    updated_at: now,
    deleted: false,
  };
  await savedQueryStore().save([query]);
  return query;
}

export async function updateSavedQuery(tenant: string, id: string, body: Record<string, unknown>, by: string): Promise<SavedQuery> {
  const query = await findSavedQuery(tenant, id);
  const name = field(body, 'name', MAX_NAME_LENGTH, false);
  const sql = field(body, 'sql', MAX_SQL_LENGTH, false);
  const next = { ...query, name: name ?? query.name, sql: sql ?? query.sql, updated_by: by, updated_at: version() };
  await savedQueryStore().save([next]);
  return next;
}

export async function deleteSavedQuery(tenant: string, id: string, by: string): Promise<void> {
  const query = await findSavedQuery(tenant, id);
  await savedQueryStore().save([{ ...query, deleted: true, updated_by: by, updated_at: version() }]);
}

export const presentSavedQuery = (q: SavedQuery) => ({
  id: q.id,
  name: q.name,
  sql: q.sql,
  created_by: q.created_by || null,
  created_at: new Date(q.created_at).toISOString(),
  updated_by: q.updated_by || null,
  updated_at: new Date(q.updated_at).toISOString(),
});
