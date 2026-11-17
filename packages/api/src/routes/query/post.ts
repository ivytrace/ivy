import type { Context } from 'hono';
import { jsonBody } from '../../lib/aws/requests.js';
import { QueryError, runWorkspaceQuery } from '../../lib/clickhouse/workspace-query.js';
import { dataScopeOf } from '../../lib/tenancy/context.js';
import { badRequest } from '../../lib/utils/http-error.js';
import { parseTimeRange } from '../../lib/utils/time-range.js';

export const DEFAULT_ROW_LIMIT = 1000;
export const MAX_ROW_LIMIT = 10_000;

const optionalString = (body: Record<string, unknown>, key: string) => {
  const value = body[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest(`${key} must be a string`);
  return value;
};

/**
 * `{ "sql": "SELECT …", "since"?: "24h", "from"?, "to"?, "limit"?: 1000 }`: runs the SQL against the Query page's
 * views as the workspace's own ClickHouse user (docs/implementation/query.md), in the request's project (or every
 * project) and time range.
 */
export async function postQuery(c: Context) {
  const body = await jsonBody(c);
  if (typeof body.sql !== 'string') throw badRequest('sql is required');
  const limit = body.limit === undefined ? DEFAULT_ROW_LIMIT : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROW_LIMIT) throw badRequest(`limit must be between 1 and ${MAX_ROW_LIMIT}`);
  const range = parseTimeRange({ since: optionalString(body, 'since'), from: optionalString(body, 'from'), to: optionalString(body, 'to') });
  const scope = dataScopeOf(c);
  try {
    const result = await runWorkspaceQuery({ tenant: scope.tenant, projectId: scope.projectId, range, sql: body.sql, maxRows: limit });
    return c.json({ ...result, range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() } });
  } catch (err) {
    if (err instanceof QueryError) return c.json({ error: err.message }, err.status);
    throw err;
  }
}
