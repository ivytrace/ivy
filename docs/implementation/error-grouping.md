# Error grouping

Failed invocations are grouped so one bug is one row on the errors page, one line in `list_error_groups` and one
alert, however many different IDs, paths or numbers its messages contain.

## Fingerprint

```
fingerprint = lower(hex(cityHash64(function, error_type, error_frame, error_template)))
```

- **function**: `faas.name`, else the service name.
- **error_type**: `error.type`, else the `exception` event's type.
- **error_frame**: the code location, `file:function` of the top in-app stack frame, without line and column so a
  deploy doesn't split a group. Empty when there is no stack (platform failures, errors thrown without one).
- **error_template**: the message with its variable parts replaced (below).

Throttles keep their synthetic `throttled:<region>:<function>` fingerprint (`api.md`).

## Message template

`errorTemplate(message, errorType)` in `@ivy/spans` (`packages/spans/src/error-template.ts`):

1. The first line of the message, trimmed, cut to 300 characters before anything else.
2. `Runtime.ImportModuleError` and `Runtime.HandlerNotFound` keep that line as it is: the message names the missing
   module or handler, and `Cannot find module 'left-pad'` and `… 'mjml'` are different problems.
3. Otherwise these rules run in order, each replacing every match:

| rule | example | becomes |
|---|---|---|
| quoted text with a space, or over 40 characters (`'…'`, `"…"`, `` `…` ``) | `Unknown product "Red Hoodie"` | `{str}` |
| URLs (any scheme) | `https://api.example.com/v1/orders/123` | `{url}` |
| emails | `bob@example.com` | `{email}` |
| UUIDs | `3f1c9a2e-7b44-…` | `{id}` |
| ISO dates and timestamps | `2026-11-14T10:00:00.000Z` | `{date}` |
| IPv4 addresses, optional port | `10.0.1.25:5432` | `{ip}` |
| ARNs | `arn:aws:dynamodb:…:table/orders` | `{id}` |
| absolute and `./` `../` `~/` paths | `/tmp/abc123/data.json` | `{path}` |
| relative paths with an extension or two slashes | `fonts/mono-regular.woff` | `{path}` |
| file names with a known extension, lowercase start | `favicon.ico`, `_mermaid.js` | `{path}` |
| prefixed IDs with a digit | `cus_NffrFeUfNV2Hib`, `usr_123` | `{id}` |
| hex runs of 8 or more | `507f1f77bcf86cd799439011` | `{id}` |
| numbers on their own, optional unit | `3.00`, `-1`, `500ms`, `1.2.3` | `{num}` |
| the token after `id:`, `id=`, `key:`, `userId=`, `order_id:` … | `ID: report` | `ID: {id}` |

Decisions, each with a test vector (`error-template.vectors.ts`):

- **Short quoted words stay.** `(reading 'id')` and `(reading 'map')` are different bugs, and enum-like values
  (`Invalid status 'archived'`) are usually the point of the message. A quoted single token still has IDs, paths and
  numbers inside it replaced: `No such customer: '{id}'`, `open '{path}'`. Quotes need a non-word character on both
  sides, so the apostrophes in `can't` and `user's` are not quotes.
- **Numbers inside words stay**: `v2`, `utf8`, `s3`, `utf-8`. Status codes are numbers (`status code {num}`); the
  expanded group shows which ones occurred.
- **Paths need a shape**: `application/json`, `text/html` and `and/or` stay, and so do capitalised names like
  `Node.js`; `README.md` stays too (accepted).
- **Hostnames stay** (`getaddrinfo ENOTFOUND api.example.com`): a different host is usually a different problem.
- **Not handled**: random IDs without digits or hex (`x7Kp2mQ9zR` is caught only after `id:`-style separators), IPv6,
  and US-style dates (`11/14/2026` becomes `{path}`).

`templateParts` splits a template into text and placeholders for display (placeholders are muted in the dashboard).

## Where it runs

**Template and fingerprint: at query time, in ClickHouse.** `errorTemplateSql()` turns the same rule list into nested
`replaceRegexpAll` calls, so the rules are written once. They are restricted to what JavaScript and RE2 agree on
(ASCII classes, `\b`/`\B`, `(?:…)`, no lookaround, no `\s`). `error-groups.clickhouse.test.ts` runs every test vector
through ClickHouse and expects the same output as the unit test (`IVY_TEST_CLICKHOUSE_URL`).

Why query time rather than a stored column: existing rows regroup as soon as the API is updated, and a later change to
the rules needs no migration. The cost is 16 regex passes per failed invocation in the queried range, which is
small next to everything else the errors page reads (failed invocations are a fraction of all rows). Queries that
filter by fingerprint (`group` on the invocations list) compute it over the failed rows of the range; the alert
evaluator first narrows to the (function, error type) pairs with a recent failure, which the primary key serves.

**Code location: at ingest, in the materialized view** (`error_frame`, `deploy/clickhouse/schema.sql`), because the
stack trace is only in `otel_traces`:

- JavaScript: the first `at …` line with a `/` that is not in `node_modules`, `node:` or `internal/` modules, the
  Lambda runtime (`/var/runtime/`) or the Ivy layer (`/opt/nodejs/`). `file://` and `?query` are stripped, then
  `:line:column`. `at async getUpload (file:///var/task/uploads.mjs:40:11)` → `/var/task/uploads.mjs:getUpload`.
- Python: the last `File "…", line N, in fn` outside `site-packages`, `dist-packages`, `/var/runtime/` and
  `/var/lang/` (tracebacks list the innermost frame last). → `/var/task/orders.py:process`.
- Minified bundles whose function names change per build split groups on deploy; source maps are not applied.

The view used to store `error_fingerprint`; the column is dropped by the schema run.

## Upgrading

- Rows stored before `error_frame` existed have no code location. Templates regroup them at once, but a bug that
  spans the upgrade shows as two groups (one without a code location) until the older rows leave the selected time
  range, at most the retention period.
- Alert state is keyed by fingerprint, so every group gets a new key. A group without state whose function, error type
  and template had occurrences in the 7 days before the evaluator's candidate window is treated as already seen
  (`seen_before`): it gets a baseline state instead of a "New error" message (`alerts.md`). The weekly digest takes a
  group's first occurrence across all fingerprints with the same template, so regrouped errors aren't listed as new.

## Surfaces

- API: `error_template`, `variants` (distinct raw messages in the range) and `top_messages` (up to 5, most frequent
  first, each with its count, latest trace and last seen) on every error group; `group=<fingerprint>` on the
  invocations list (`api.md`).
- Dashboard errors page: one row per group with the template (placeholders muted; the message itself when the group has one), variants, occurrences, first and
  last seen; groups with several messages expand to their top messages, each linking to its trace. "Invocations"
  opens the list filtered to the group.
- MCP `list_error_groups` and the text format: the template, `N variants` and the most frequent message
  (`mcp.md`). `find_failing_invocations` lists raw messages as before.
- Slack and the digest: the template plus "N variants" when a group has several messages, else the message.
- The MCP App views show traces only, so nothing changes there.
