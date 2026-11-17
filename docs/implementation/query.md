# Query page

Members write their own SQL (ClickHouse dialect) over a workspace's invocations, spans and logs: the dashboard's
Query page, `POST /api/w/:workspace[/p/:project]/query`, and the MCP tool `run_query`. Examples: the API routes with
the slowest p95, invocations with 30 or more database calls.

## Decision: ClickHouse enforces the workspace boundary, not Ivy's code

User SQL can't be checked with the API's own guard (`assertTenantScoped` counts `{tenant:String}` filters, which a
user can simply write), and the row policies the API relies on (`SQL_ivy_tenant`) let everything through without
the setting and can be overridden by a `SETTINGS` clause. Parsing and rewriting the SQL was the alternative; it puts
the security boundary in a parser that has to understand everything ClickHouse accepts.

Instead the SQL runs as a ClickHouse user of its own per workspace, `ivy_q_<tenant ID>`, with the role `ivy_query`
(`deploy/clickhouse/schema.sql`, "Query page"):

- **Row policies** (restrictive, on every span table) let the role read only rows whose tenant is the user's name
  without the `ivy_q_` prefix (`tenant_id = replaceOne(currentUser(), 'ivy_q_', '')`). The name is the login; a query
  can't change it. Any other name matches no tenant, so it fails closed. The policies are on the tables, so they
  hold through the views, `merge()` and direct reads of `ivy.otel_traces` alike.
- **Grants**: `SELECT` on the `ivy_query` views and the two tables behind them, nothing else. No `ivy_control`, no
  `system.*` (ClickHouse's default config has `select_from_system_db_requires_grant` on; `system.one` and the
  `system.tables`/`columns` rows of granted tables stay visible), no table functions (`url`, `file`, `s3`, `remote`,
  `mysql`, … each need a grant), no temporary tables.
- **Settings profile** `ivy_query`: `readonly = 1` (const), so no writes, DDL or `SET`. Only settings marked
  `CHANGEABLE_IN_READONLY` can be set at all, by the API or a `SETTINGS` clause: the scope settings below and the
  limits, which have a `MAX` so a query can lower them but not raise them: 30 s, 1 billion rows read, 2 GB memory,
  4 threads, 10,000 result rows / 10 MB (`result_overflow_mode = 'break'`), 4 concurrent queries.
- **Quota** `ivy_query`, keyed by user name (so per workspace): 60 queries a minute, 30 minutes of execution an hour.

`workspace-query.clickhouse.test.ts` runs this against a real ClickHouse: other workspaces' rows stay out (also with
widened scope settings, raw table reads and `merge()`), writes, `SET readonly`, raised limits, system tables and table
functions are refused, and the views still prune by tenant, project and time.

## The views

Database `ivy_query`, all `SQL SECURITY INVOKER` (they run with the caller's rights, so the policies apply):

| view | rows |
|---|---|
| `invocations` | one per invocation (from `ivy.invocations`); `http_route` is the route template when the trigger gives one, else the path |
| `spans` | every span except update spans and in-progress records, with flattened columns (`category`, `aws_service`, `db_system`, `http_host`, …), `calls` (1, or the call count of a collapsed summary span) and the attribute maps |
| `logs` | `log` events of invocation spans: level and message |

They show the project and time range the page is looking at, from the settings `SQL_ivy_project` ('' = all projects)
and `SQL_ivy_from_ms` / `SQL_ivy_to_ms` that the API sets per query. These are a convenience, not a boundary: a user
can widen them in a `SETTINGS` clause and still only sees their own workspace. `getSettingOrDefault` folds to a
constant, so the conditions reach the primary key and partition pruning (checked with `EXPLAIN indexes = 1` in the
test).

Column names, types and descriptions for the editor, the schema panel and the MCP tool are in
`packages/spans/src/query.ts` (`QUERY_TABLES`); the ClickHouse test checks they match the views.

`ivy.invocations` gained `http_route` (`http.route` of the invocation span) for this; rows from before have ''.

## The query user

Created by the API on a workspace's first query, per shard, and brought up to date once per API process
(`lib/clickhouse/workspace-query.ts`): `CREATE USER IF NOT EXISTS`, `ALTER USER` (password, default database
`ivy_query`, profile), `GRANT ivy_query`, `DEFAULT ROLE ivy_query`. The API's ClickHouse user therefore needs access
management (the compose file sets `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1`).

The password is `HMAC-SHA256(IVY_SECRET_KEY, 'ivy-query-user:' + tenant)` (falling back to `IVY_CLICKHOUSE_PASSWORD`
when no secret key is set), so every API process derives the same one and nothing is stored. When a query fails
authentication (the secret changed, the user was dropped), the API sets the user up again and retries once. Deleting
a workspace drops its user (best effort: nothing routes to a deleted workspace anyway).

## Running a query

`runWorkspaceQuery` strips trailing semicolons, sends the SQL with `JSONCompactEachRowWithNamesAndTypes`,
`wait_end_of_query = 1` (so the summary header has the final rows read and elapsed time) and `max_result_rows` one
above the requested limit (default 1,000, at most 10,000). ClickHouse stops at the end of the block that crosses it;
the API cuts the rows to the limit and reports `truncated`. ClickHouse errors (bad SQL, limits, no access) are
answered as 400 with ClickHouse's message (429 for the quota and concurrency limits). A `FORMAT` clause is refused
with a hint, since results are always a table.

## Saved queries

`ivy_control.saved_queries`, per workspace, shared by all members (any member can change or delete any of them).
`GET/POST /queries`, `PATCH/DELETE /queries/:id`; deleted rows are kept as tombstones (ReplacingMergeTree).

Default queries (`DEFAULT_QUERIES` in `@ivy/spans`: slowest API routes, invocations with 30+ database calls, slowest
AWS calls, cold starts per function, recent error logs) are saved into a workspace the first time its list is read
(or a query is saved), under IDs derived from their key (`qry_default_<key>`). Each is saved once: editing or deleting
it sticks, concurrent first reads write the same rows, and a default added later still reaches existing workspaces.

## Dashboard

`/w/:workspace/:project/query?q=<saved query ID>`, lazy-loaded (CodeMirror). Left: saved queries and the tables with
their columns (click to insert). The editor (`components/query/sql-editor.tsx`) completes the columns of the tables
the query reads (with type and description), table names, common ClickHouse functions and keywords; ⌘↵ runs, ⌘S
saves. Opening a saved query runs it; changing the project or time range re-runs the last query. Results show the
ClickHouse type under each column name, link `trace_id` values to their trace (in the row's `project_id` when the
result has one) and download as CSV. An unsaved query is kept per workspace in localStorage.

## AI

Not built yet. The plan: a prompt that writes SQL into the editor for the user to read and run, with the same views
and limits. Restricting users to prompts would not make this safer: anyone can prompt a model into writing any SQL,
so the guards above are needed either way.
