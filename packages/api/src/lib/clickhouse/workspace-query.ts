import { createHmac } from 'node:crypto';
import { ClickHouseError, ClickHouseLogLevel, createClient, type ClickHouseClient } from '@clickhouse/client';
import type { QueryResult } from '@ivy/spans';
import type { Tenant } from '../tenancy/context.js';
import { shardConfig } from '../tenancy/shards.js';
import type { TimeRange } from '../utils/time-range.js';
import { shardClient } from './client.js';

/**
 * The Query page's SQL runs as the workspace's own ClickHouse user, `ivy_q_<tenant ID>`, with the role `ivy_query`
 * (deploy/clickhouse/schema.sql, "Query page"). Its row policies, grants and settings profile are the guard, not
 * this code: see docs/implementation/query.md.
 */
const names = { database: 'ivy_query', role: 'ivy_query', profile: 'ivy_query' };

const env = (name: string) => process.env[name]?.trim() || undefined;

export const QUERY_USER_PREFIX = 'ivy_q_';
export const queryUserName = (tenantId: string) => `${QUERY_USER_PREFIX}${tenantId}`;

const TENANT_ID = /^[A-Za-z0-9_]{1,64}$/;

/** Derived, so every API process sets the same password and nothing is stored. */
function queryUserPassword(tenantId: string): string {
  const secret = env('IVY_SECRET_KEY') ?? env('IVY_CLICKHOUSE_PASSWORD') ?? 'ivy';
  return createHmac('sha256', secret).update(`ivy-query-user:${tenantId}`).digest('base64url');
}

/** A query the user should see the reason for (invalid SQL, a limit, no access), as opposed to a failure of Ivy. */
export class QueryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 429 = 400,
  ) {
    super(message);
  }
}

const provisioned = new Map<string, Promise<void>>();

/** Creates the workspace's query user on its shard, or brings its password, profile and role up to date. */
async function provision(shardId: string, tenantId: string): Promise<void> {
  if (!TENANT_ID.test(tenantId)) throw new Error(`Tenant ID ${tenantId} can't be a ClickHouse user name`);
  const admin = shardClient(shardId);
  const user = queryUserName(tenantId);
  const identity = `IDENTIFIED WITH sha256_password BY '${queryUserPassword(tenantId)}' DEFAULT DATABASE ${names.database} SETTINGS PROFILE '${names.profile}'`;
  await admin.command({ query: `CREATE USER IF NOT EXISTS ${user} ${identity}` });
  await admin.command({ query: `ALTER USER ${user} ${identity}` });
  await admin.command({ query: `GRANT ${names.role} TO ${user}` });
  await admin.command({ query: `ALTER USER ${user} DEFAULT ROLE ${names.role}` });
}

function ensureQueryUser(tenant: Tenant): Promise<void> {
  const key = `${tenant.shardId}/${tenant.id}`;
  let pending = provisioned.get(key);
  if (!pending) {
    pending = provision(tenant.shardId, tenant.id);
    provisioned.set(key, pending);
    pending.catch(() => provisioned.delete(key));
  }
  return pending;
}

/** Removes a deleted workspace's query user from its shard. */
export async function dropQueryUser(tenant: Tenant): Promise<void> {
  if (!TENANT_ID.test(tenant.id)) return;
  provisioned.delete(`${tenant.shardId}/${tenant.id}`);
  await shardClient(tenant.shardId).command({ query: `DROP USER IF EXISTS ${queryUserName(tenant.id)}` });
}

const clients = new Map<string, ClickHouseClient>();

function queryClient(tenant: Tenant): ClickHouseClient {
  const key = `${tenant.shardId}/${tenant.id}`;
  let client = clients.get(key);
  if (!client) {
    client = createClient({
      url: shardConfig(tenant.shardId).clickhouse,
      username: queryUserName(tenant.id),
      password: queryUserPassword(tenant.id),
      database: names.database,
      // ClickHouse's own limit (max_execution_time, 30 s) answers first, with a better message.
      request_timeout: 40_000,
      // Bad SQL is the user's to fix, not a server error to log.
      log: { level: ClickHouseLogLevel.OFF },
    });
    clients.set(key, client);
  }
  return client;
}

export interface WorkspaceQuery {
  tenant: Tenant;
  /** The project the views show, or null for every project of the workspace. */
  projectId: string | null;
  range: TimeRange;
  sql: string;
  maxRows: number;
}

/** Trailing semicolons are harmless to people but make ClickHouse's HTTP interface see two statements. */
export const cleanSql = (sql: string) => sql.trim().replace(/[;\s]+$/, '');

const ERROR_CODES = {
  AUTHENTICATION_FAILED: '516',
  QUOTA_EXCEEDED: '201',
  TOO_MANY_SIMULTANEOUS_QUERIES: '202',
};

function userMessage(err: ClickHouseError): string {
  return err.message.replace(/\s*\(version [^)]*\)\s*$/, '').trim();
}

async function execute(q: WorkspaceQuery, sql: string): Promise<QueryResult> {
  const started = Date.now();
  const result = await queryClient(q.tenant).query({
    query: sql,
    format: 'JSONCompactEachRowWithNamesAndTypes',
    clickhouse_settings: {
      SQL_ivy_project: q.projectId ?? '',
      SQL_ivy_from_ms: String(q.range.from),
      SQL_ivy_to_ms: String(q.range.to),
      // Ends the result at the first block past the cap (result_overflow_mode = 'break'); rows beyond it are dropped here.
      max_result_rows: String(q.maxRows + 1),
      // The whole result before the headers, so the summary header has the final numbers.
      wait_end_of_query: 1,
    },
  });
  const [names = [], types = [], ...rows] = await result.json<unknown[]>();
  const summary = JSON.parse(result.response_headers['x-clickhouse-summary']?.toString() ?? '{}') as Record<string, string>;
  return {
    columns: (names as string[]).map((name, i) => ({ name, type: String((types as string[])[i] ?? '') })),
    rows: rows.slice(0, q.maxRows),
    truncated: rows.length > q.maxRows,
    stats: {
      rows_read: Number(summary.read_rows ?? 0),
      bytes_read: Number(summary.read_bytes ?? 0),
      elapsed_ms: summary.elapsed_ns ? Math.round(Number(summary.elapsed_ns) / 1e6) : Date.now() - started,
    },
  };
}

/** Runs a member's SQL as the workspace's query user. Errors the user can act on are QueryErrors. */
export async function runWorkspaceQuery(q: WorkspaceQuery): Promise<QueryResult> {
  const sql = cleanSql(q.sql);
  if (!sql) throw new QueryError('The query is empty');
  await ensureQueryUser(q.tenant);
  try {
    try {
      return await execute(q, sql);
    } catch (err) {
      // The user was dropped, or IVY_SECRET_KEY changed: set it up again once.
      if (!(err instanceof ClickHouseError) || err.code !== ERROR_CODES.AUTHENTICATION_FAILED) throw err;
      provisioned.delete(`${q.tenant.shardId}/${q.tenant.id}`);
      await ensureQueryUser(q.tenant);
      return await execute(q, sql);
    }
  } catch (err) {
    if (err instanceof ClickHouseError) {
      const busy = err.code === ERROR_CODES.QUOTA_EXCEEDED || err.code === ERROR_CODES.TOO_MANY_SIMULTANEOUS_QUERIES;
      throw new QueryError(userMessage(err), busy ? 429 : 400);
    }
    if (err instanceof Error && /format was requested/.test(err.message)) {
      throw new QueryError('Remove the FORMAT clause: results are always returned as a table.');
    }
    throw err;
  }
}

/** Points the module at a throwaway database, role and profile (see test-schema.ts). */
export function setQueryNamesForTests(next: typeof names | undefined) {
  Object.assign(names, next ?? { database: 'ivy_query', role: 'ivy_query', profile: 'ivy_query' });
  provisioned.clear();
  for (const client of clients.values()) void client.close();
  clients.clear();
}
