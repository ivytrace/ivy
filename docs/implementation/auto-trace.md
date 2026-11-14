# Auto-trace: connecting AWS accounts (M4)

Users connect an AWS account to a **workspace** from **Workspace settings → AWS accounts**. Ivy then lists every
function in the selected regions and attaches the Node.js layer to the functions the user **selects**, into the
project they choose, including new functions that match their selection later. Tracing is **opt-in**: connecting an
account traces nothing. Code lives in `packages/api/src/lib/aws/` and `packages/api/src/routes/aws/`, the UI in
`packages/ui/src/routes/settings/` and `packages/ui/src/components/aws/`. Projects: `workspaces-projects.md`.

## Flow

1. **Connect.** The user enters the 12-digit account ID, a stack region, the regions to scan and optionally the project
   to preselect. `POST /api/w/:ws/aws/accounts` creates a *pending* connection with a random external ID
   (`ivy-<32 hex>`), an event secret, and a deterministic role name `IvyTrace-<8 hex>` (so the role ARN is known before
   the stack exists).
2. **Deploy.** With the `publish-cfn-template` hook (`hooks.md`), the account has a quick-create link: the user opens it
   in a new tab (signed in to the target account), ticks the IAM acknowledgement and creates the stack. Without the hook
   (or when it fails), the UI offers "Download template" (the connection's values filled in) plus "Upload a template
   file" steps.
3. **Verify.** The UI calls `POST /api/w/:ws/aws/accounts/:id/verify` every 10 s once the user has opened the link or
   download, and on "I've deployed it, verify". Verify calls `sts:AssumeRole` with the external ID. The first success
   marks the account *connected*, fires `on-aws-account-connected`, and starts the first sync. A failure keeps it
   *pending* and shows the STS error.
4. **First sync: list.** For each region: `ListFunctions` (paginated) and `tag:GetResources` for tags. Every supported
   function is stored as `available` with its runtime, CloudFormation stack (the `aws:cloudformation:stack-name` tag),
   tags and last-modified time. Nothing is changed in the account yet.
5. **Pick.** The account page groups functions by stack. The user traces a stack (a stack rule into a project, often a
   new one named after the stack), filters by name/stack/tag/region and traces all matches (a rule) or a selection
   (manual choices), and can exclude single functions. `POST …/aws/rules/dry-run` previews what a rule would select.
6. **Sync: attach.** Each rule change, manual choice or interval sync plans every function (below): `PublishLayerVersion`
   if needed, `UpdateFunctionConfiguration` for functions that change, one batch of status rows into ClickHouse. Traces
   arrive after each function's next invocation.
7. **Stay in sync.** A background loop in the API process re-syncs every connected account every
   `IVY_AWS_SYNC_INTERVAL_SECONDS` (default 300). New functions that match an enabled rule are traced on the next sync;
   the others stay `available` and count as "new" in the UI until the user has looked at the list
   (`PATCH …/accounts/:id { reviewed: true }`). Optionally, EventBridge pushes function changes for an immediate sync.
8. **Untrace.** When a function stops being selected (its rule is deleted or disabled, a tag changes, a manual exclude,
   its project is archived), the next sync removes the layer and Ivy's variables. Disconnecting an account detaches the
   layer from all its functions first (unless `detach=false`) and then tells the user to delete the stack.

## Choosing functions and projects

`lib/aws/assign.ts` (pure, unit-tested) decides per function whether it is traced and into which project:

1. **Tags.** `ivy:trace=false` never traces (`opted_out`). `ivy:trace=true` traces, given a project (below).
2. **Manual choice** in the dashboard (`aws_function_settings.mode`): `trace` into a project, or `exclude` (`opted_out`).
3. **Rules** of the workspace (`aws_project_rules`), in order: the first enabled rule that matches, and whose project is
   active, traces the function into its project.
4. Otherwise not traced: `available`.

Whenever a function is traced, an `ivy:project=<slug>` tag naming an active project of the workspace picks the project;
otherwise the manual choice's project or the rule's project. `ivy:project` alone doesn't trace. Archived projects are
skipped (a rule pointing at one matches nothing).

**There is no default project** (`workspaces-projects.md`): every rule and every manual "trace" names a project (the
API answers 400 without one; the UI always asks, preselecting the stack's suggested project or the project last used
for tracing in this browser, then the account's preselected project). A function selected without an active project
gets the state **`needs_project`** and is not traced (detached if it was): `ivy:trace=true` without an `ivy:project`
naming an active project and without a manual choice or rule that gives one, or a manual choice whose project was
archived. The account page lists it as "Needs a project" with the reason and a project picker that saves a manual
choice. On upgrade, functions that were traced by `ivy:trace=true` alone into the old default project got that project
as a manual choice (`keepTagTracedFunctions`), so they kept tracing.

A **rule** is a matcher plus a project plus `enabled`. Every non-empty matcher field must match: `account_id` and
`region` exactly, `stack` (the CloudFormation stack name) and `name` (the function name) as globs (`*`, `?`;
`orders-*` is a prefix match), `tag` as `key=value` (value may be a glob) or `key`. **Stacks are the main way to pick
functions**: a stack is usually one app in one environment, which is one project (`checkout-prod` →
project `checkout-prod`). Serverless Framework, SAM, CDK and SST all set the stack tag. A stack rule is just a
rule whose matcher has only `stack` (the account page shows it on the stack's group).

The account's `default_project_id` is only the project the UI offers first; it never causes tracing and is not a fallback.

Each traced function gets its **project's** ingest key as `IVY_API_KEY` (one auto-trace key per project, `tenancy.md`).
When a function moves to another project, the next sync rewrites `IVY_API_KEY`; spans already ingested stay in the
project they were sent to (data is immutable), and the UI says so.

**Upgrading:** connections made before opt-in tracing had every supported function traced. After the upgrade those
functions are `available` (no rule exists) and the next sync detaches them, unless the workspace adds a rule first,
e.g. `{ "matcher": { "name": "*" } }` for the old behaviour.

### For coding agents (llms.txt)

The agent flow the website's llms.txt should describe: ask the user which functions to trace, by CloudFormation stack
(preferred) or by name pattern/tag; preview the matches with `POST /api/w/:ws/aws/rules/dry-run` and show them; then
create the rule with `POST /api/w/:ws/aws/rules` (with `new_project: { name, slug }` to trace a stack into a new
project of the same name). Single functions: `PUT /api/w/:ws/aws/functions/:account/:region/:name` with
`{ "mode": "trace" | "exclude" | "rules" }`. `api.md` has the shapes.

## Decisions

### Where config lives: four small ClickHouse tables

No new datastore. `deploy/clickhouse/schema.sql` adds, in the control-plane database `ivy_control` (`tenancy.md`; all
`CREATE TABLE IF NOT EXISTS`, `tenant_id` first in `ORDER BY`):

| table | engine | key | |
|---|---|---|---|
| `aws_accounts` | `ReplacingMergeTree(updated_at)` | `(tenant_id, id)` | one row per connection: role ARN, external ID, event secret, regions, preselected project, `reviewed_at`, status, last error, timestamps, `deleted` flag |
| `aws_functions` | `ReplacingMergeTree(updated_at)` | `(tenant_id, account_id, region, function_name)` | last known state per function: `traced`/`available`/`opted_out`/`unsupported`/`conflict`/`error`/`pending` + reason, project and what decided it (`tag`/`manual`/`rule` + rule ID), stack, tags, last modified, `first_seen_at` |
| `aws_function_settings` | `ReplacingMergeTree(updated_at)` | `(tenant_id, account_id, region, function_name)` | the manual choice: `mode` (`''`/`trace`/`exclude`) and its project; older rows' `tracing_enabled = false` reads as `exclude` |
| `aws_project_rules` | `ReplacingMergeTree(updated_at)` | `(tenant_id, id)` | the workspace's rules: position, matcher fields, project, enabled, `deleted`. Reordering writes all rows in one insert |

- Every update inserts a full row; reads use `FINAL` and `NOT deleted`. Deleting inserts a row with `deleted = 1`.
  The store gives each write a version strictly above its previous one, so two writes in the same millisecond keep
  their order.
- Settings are keyed by AWS account ID (not connection ID) so manual choices survive disconnecting and reconnecting.
  They are kept apart from `aws_functions` so a sync that read a function before a manual choice can't overwrite the choice.
- Read-modify-write races (a sync finishing while the user edits regions) are narrowed by re-reading the account right
  before saving sync results; the worst case is a lost `last_sync_at`/`error` update that the next sync rewrites.
- Volumes are tiny (rows per function, rewritten once per sync interval), well within what ReplacingMergeTree merges away.
- The layer version per account/region is not stored: it is found again with `ListLayerVersions` (cached in memory).

### AWS identity

Ivy only uses the AWS SDK as a client; nothing of Ivy runs in AWS.

- Ivy's own credentials come from the standard SDK chain (env vars, shared config/`AWS_PROFILE`, container/instance role).
  Each install brings its own IAM user or role.
- The **trusted principal** in the template comes from `IVY_AWS_PRINCIPAL_ARN`. If unset, Ivy derives it from
  `sts:GetCallerIdentity` (an assumed-role session ARN maps back to `arn:aws:iam::<acct>:role/<name>`). If neither works,
  `GET /api/w/:ws/aws/setup` reports it as an issue and the template has no default for the parameter.
- `AssumeRole` goes to the regional STS endpoint of `IVY_AWS_REGION`/`AWS_REGION` (default `us-east-1`); regional STS
  tokens are valid in opt-in regions too. Credentials are cached per role until 5 minutes before expiry.
- The **external ID** is unique per connection (`randomBytes(16)`), and is a template parameter, as is the principal.

### The template

`buildTemplate()` in `lib/aws/template.ts`, served as YAML by `GET /api/w/:ws/aws/template.yaml`.

- Parameters: `TrustedPrincipalArn`, `ExternalId`, `RoleName`, `EventsUrl` (optional), `EventSecret` (`NoEcho`).
  Without `?account=` the template is generic (only the principal has a default): that's the file to publish to S3.
  With `?account=<id>` all defaults are filled in for the download-and-upload path.
- Role policy (least privilege): `lambda:ListFunctions`, `GetFunction`, `GetFunctionConfiguration`,
  `UpdateFunctionConfiguration`, `ListLayerVersions`, `tag:GetResources` and `cloudwatch:GetMetricData` (throttles, see
  "Throttles" below; it has no resource-level permissions) on `*`; `PublishLayerVersion` and
  `GetLayerVersion` only on `arn:…:lambda:*:<acct>:layer:ivy-trace-nodejs[:*]`. Trust: the principal, with an
  `sts:ExternalId` condition. The role is tagged `ivy:component`.
- One template per connection: every value (trusted principal, external ID, role name, events URL, event secret) is a
  parameter whose default is this connection's value; the event secret is `NoEcho`. So the file can be uploaded as is,
  and a quick-create link needs no `param_…` values, which keeps the external ID and the secret out of URLs.
- **Quick-create needs the template at an S3 URL.** Ivy doesn't host it: the `publish-cfn-template` provider hook
  (`hooks.md`) receives the rendered template and returns a URL CloudFormation can fetch (e.g. a short-lived
  pre-signed S3 URL). The API builds `https://<region>.console.aws.amazon.com/cloudformation/home?region=…#/stacks/quickcreate?templateURL=…&stackName=…`
  and caches it per connection until shortly before the URL expires. Without the hook, or when it fails, there is no
  link (`quick_create_url: null`, plus `quick_create_error` on failure) and the UI offers the download, which needs the
  user's token (`GET /api/w/:ws/aws/template.yaml?account=…`) because it contains the event secret.
  Why a hook rather than a public template: a generic template would need the per-connection values (including
  the secret) as link parameters, or a public unauthenticated route. Earlier versions did the former with
  `IVY_CFN_TEMPLATE_URL`; that variable is gone.
- Checked with `cfn-lint` in `template.test.ts` (runs when `cfn-lint` is on the PATH) and by structure assertions.

### Getting the layer into the account

`PublishLayerVersion` of the zip that ships in the API image (`/app/layer.zip`, built by `packages/api/Dockerfile`; in
development `packages/layer/dist/layer.zip`; override with `IVY_LAYER_ZIP`) into each account and region, as
`ivy-trace-nodejs`, through the assumed role. No public or cross-account layers needed, for any install. The description carries `sha256:<zip hash>`; before publishing Ivy looks for a version with the same hash,
so restarts and other Ivy processes reuse it. A new Ivy build with a different zip publishes a new version and the next
sync moves every traced function to it. A region only gets the layer when some function there needs it.

Note: the zip is rebuilt per image build and `zip` stores mtimes, so each image build counts as a new layer version.

### Detecting new functions

- **Baseline: polling.** `startSyncLoop()` (in `src/index.ts`, not in `createApp`) ticks every minute and syncs each
  non-pending account whose `last_sync_at` is older than the interval. It works anywhere, including behind a firewall.
  Within a process, `triggerSync` never runs two syncs of the same account at once (requests that arrive meanwhile are
  merged into one follow-up run). Across processes it is still safe: every `UpdateFunctionConfiguration` carries the
  `RevisionId` the plan was based on, so a concurrent change makes the update fail with `PreconditionFailedException`;
  Ivy then re-reads the function and plans again once. Plans are idempotent, so a duplicate sync changes nothing.
- **Optional: EventBridge.** When `IVY_PUBLIC_URL` is an `https://` URL, the template parameters `EventsUrl`
  (`<public url>/api/aws/events`) and `EventSecret` get defaults and the stack also creates an EventBridge connection
  (API key header `x-ivy-event-secret`), an API destination, a role for it and a rule on CloudTrail `CreateFunction*` /
  `UpdateFunctionConfiguration*` events from `lambda.amazonaws.com`. `POST /api/aws/events` looks the connection up by
  secret, checks the event's `account`, and syncs that region. Caveats:
  - "AWS API Call via CloudTrail" events need a CloudTrail trail in the account.
  - Rules are regional: only functions in the stack region get immediate events; other regions rely on polling.
  - Ivy's own `UpdateFunctionConfiguration` calls also fire the rule; the resulting sync is a no-op.
  - The endpoint must stay reachable without user auth once OIDC lands (M3 auth is not built yet).

### Attach logic (`lib/aws/attach.ts`, pure and unit-tested)

In order:

1. Tag `ivy:component` (anything Ivy's own stacks create) → `unsupported`, untouched.
2. Container image functions, and runtimes other than `nodejs18.x` or later → `unsupported` (detached if Ivy's layer is somehow there).
3. Not selected by the assignment above (tag `ivy:trace=false`, a manual exclude → `opted_out`; nothing selects it →
   `available`): if attached, remove the Ivy layer, `IVY_ENDPOINT`, `IVY_API_KEY`, and `AWS_LAMBDA_EXEC_WRAPPER` only
   when it is `/opt/ivy-wrapper`. Other variables (including other `IVY_*` such as `IVY_REDACT_KEYS`) and layers stay.
4. Environment unreadable (`Environment.Error`, e.g. a KMS key the role can't use) → `error`; never write variables Ivy
   couldn't read, since `UpdateFunctionConfiguration` replaces them all.
5. `AWS_LAMBDA_EXEC_WRAPPER` set to something else → `conflict`. Five non-Ivy layers already → `conflict`.
6. No ingest config → `pending`. Otherwise: desired layers = existing non-Ivy layers + the current Ivy layer version
   (older Ivy versions replaced), desired env = existing + `AWS_LAMBDA_EXEC_WRAPPER=/opt/ivy-wrapper`,
   `IVY_ENDPOINT=$IVY_INGEST_PUBLIC_URL`, `IVY_API_KEY=<the function's project's auto-trace key>`. Equal to current → no call. → `traced`.

Applying: `ResourceConflictException` (an update in progress) is retried after 2, 4, 8 and 16 s. If tags could not be
read (`tag:GetResources` denied), Ivy does not attach to functions that would change, since one of them could carry
the opt-out tag; they show as `pending`. In "all enabled regions" mode, regions that reject the credentials
(`UnrecognizedClientException` etc., i.e. not enabled) are skipped silently; with explicit regions they're reported.

`ingestConfig(tenant, project)` gives the endpoint and the project's auto-trace key: `IVY_INGEST_API_KEY` for the project
of that bootstrap key, otherwise a system-managed key stored hashed and encrypted with `IVY_SECRET_KEY`
(`tenancy.md`, "Auto-trace key"). Revoking that key makes the next sync write a new one into the project's functions.

### Throttles

Throttled requests never reach the function, so neither the layer nor the extension sees them. Ivy reads them from
CloudWatch through the same role (`lib/aws/throttles.ts`):

- **When.** At the end of an account sync, if the account's `throttle_metrics` setting is on (the default) and the last
  poll is at least 5 minutes old. The sync loop syncs each account every `IVY_AWS_SYNC_INTERVAL_SECONDS` (300), so in
  practice once per sync; with a longer interval the window simply grows.
- **What.** Per region *that has traced functions* (throttles of other functions aren't stored, so other regions are
  skipped): one `GetMetricData` query for the account-level `AWS/Lambda` `Throttles` metric (no dimensions, `Sum`,
  period 60). Only if it has a non-zero point, a second call asks for `Throttles` per `FunctionName`, for the traced
  functions of that region only, limited to the first..last throttled minute; up to 500 queries per request, following
  `NextToken`.
- **Window and watermark.** `throttles_polled_to` on the account is the minute-aligned end of the last successful poll.
  The next poll reads from 10 minutes before it (CloudWatch datapoints can land late) up to the current minute, and at
  most 3 hours back (first poll, or after a gap). Errors keep the watermark, so the window is retried.
- **Storage.** `ivy.function_throttles` (per shard, like the span tables): `tenant_id, project_id, function, region,
  minute, account_id, throttles, updated_at`, `ReplacingMergeTree(updated_at)` ordered by `(tenant_id, project_id,
  function, region, minute)`, TTL = retention, row policies `ivy_tenant` and `ivy_project`, listed in
  `TENANT_SCOPED_TABLES` and `PROJECT_SCOPED_TABLES` (so reads need a `{project:String}` filter unless they are
  explicitly workspace-wide). Only non-zero minutes are written; re-reading a minute replaces its row, and reads use
  `FINAL`.
- **Projects.** A row's `project_id` is the project the function sends to when it is polled (its tag, manual choice or
  rule). Only traced functions with a project are polled, so throttles of untraced functions and of functions without
  a project (`needs_project`) are dropped: they belong to no project. A function that moves project keeps its earlier minutes under the old project, like
  its invocations.
- **API/UI.** `GET …/functions` (`throttles` per function, project-scoped and workspace-wide), `GET …/stats/timeseries`
  (`throttles` per bucket, stacked on the errors chart), and `GET …/errors` (both scopes) adds one synthetic `Throttled` group per function (no trace; the
  UI links it to the function). The MCP tool `list_error_groups` shows it and says there is no trace.
- **Missing permission.** Stacks created before Ivy asked for `cloudwatch:GetMetricData` get `AccessDenied`. The poll
  stops for that account (one denied call), stores `throttle_status = 'missing_permission'`, and the rest of the sync is
  unaffected. The account page and list tell the user to update the stack with the current template; the next poll
  after that picks up. Other errors store `throttle_status = 'error'` and are logged.
- **Setting.** `throttle_metrics` per account (`PATCH /api/aws/accounts/:id`, a switch on the account page), on by
  default. It is a setting because the API calls are billed to the customer's AWS account.

**Cost to the customer.** CloudWatch charges `GetMetricData` at $0.01 per 1,000 metrics requested (us-east-1 list price;
`GetMetricData` is excluded from the CloudWatch free tier). Each query in a request counts as one metric.

| | metrics requested | cost |
|---|---|---|
| Account-level poll, per region with traced functions | 12 per hour → 8,640 per 30-day month | **≈ $0.09 per region per month** ($0.0864) |
| 3 regions | 25,920 | ≈ $0.26 per month |
| Per-function follow-up, only in a poll that saw throttles | 1 per traced function in that region | 100 functions → $0.001 per throttled poll |
| Worst case: 100 traced functions, throttled in every poll all month | +864,000 | +$8.64 per month |

An account without throttling pays about 9 cents per region per month; throttling adds a tenth of a cent per poll per
100 traced functions. Turning the setting off stops all calls.

## API

See `api.md` (`/api/w/:workspace/aws/*`).

## Configuration (API)

| variable | | |
|---|---|---|
| `IVY_INGEST_PUBLIC_URL` | required to attach | ingest router URL reachable from Lambda, e.g. `https://ingest.example.com` (the OTLP/HTTP base, without `/v1/traces`) |
| `IVY_INGEST_API_KEY` | self-hosted | the key written into functions of its own project ("Default" in the `default` workspace; `dev-ingest-key` in compose) |
| `IVY_SECRET_KEY` | other projects | encrypts the per-project auto-trace keys; `GET …/aws/setup` lists it as an issue when unset |
| `IVY_AWS_PRINCIPAL_ARN` | recommended | principal customers trust; derived from the credentials if unset |
| AWS credentials | required | standard SDK chain: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`, `AWS_PROFILE`, or a role |
| `IVY_HOOKS_DIR` | optional | with a `publish-cfn-template` hook in it, enables one-click quick-create links (`hooks.md`) |
| `IVY_PUBLIC_URL` | optional | public `https://` URL of the API; enables the EventBridge part of the template |
| `IVY_AWS_DEFAULT_REGION` | `us-east-1` | default stack region in the connect dialog |
| `IVY_AWS_REGION` | `AWS_REGION` or `us-east-1` | region of the STS endpoint |
| `IVY_AWS_SYNC_INTERVAL_SECONDS` | `300` | polling interval; `0` disables the background loop |
| `IVY_LAYER_ZIP` | `/app/layer.zip` in the image | layer zip to publish |

## Verification

- `packages/api`: `throttles.test.ts` (poll cadence and window, account-level first, per-function only when throttled and
  only for traced functions, stored under each function's project, 500-query batches and `NextToken`, `AccessDenied` →
  `missing_permission`, other errors keep the watermark), `assign.test.ts` (matchers, globs, the precedence of tags, manual choices and rules, disabled rules,
  archived projects, `ivy:project`, `needs_project` for `ivy:trace=true` alone or an archived manual project), `attach.test.ts` (plan rules, available vs opted out), `template.test.ts` (YAML
  round trip, structure, cfn-lint, a quick-create URL without parameters), `sync.test.ts` (nothing traced on connect;
  stack, tags and last modified recorded; a stack rule traces into its project with that project's own key; new
  matching functions traced on the next sync; detach when a function stops matching; key rewritten when a function
  moves project; layer reuse/publish, conflict retry, revision conflicts, unreadable tags, disabled regions, removed
  functions, manual exclude, detach on disconnect, `needs_project` not attached and detached until a manual choice,
  `keepTagTracedFunctions` on upgrade) and `routes/aws/aws.test.ts` (all routes end to end with in-memory
  stores: connect without/with the publish hook, hook failure, grouped list and new counts, dry run, rule
  create/patch/reorder/delete with re-sync, manual choices, bulk, EventBridge), all with `aws-sdk-client-mock`; no AWS
  account involved.
- `clickhouseStore` was checked against the compose ClickHouse (upserts, FINAL reads, deletes, counts).
- The API image builds with the layer zip inside and serves `/api/aws/*` from compose.
- The UI was checked in mock mode (`VITE_MOCK=1`, plus `VITE_MOCK_EMPTY=1` and `VITE_MOCK_NO_TEMPLATE=1`).

Not verified: a real AWS account (stack deploy, AssumeRole, PublishLayerVersion, EventBridge delivery). No LocalStack test.

## Gaps

- No real-AWS or LocalStack run yet; IAM details (e.g. `PublishLayerVersion` resource ARN form) are per the docs only.
- Functions with KMS-encrypted environments (customer key) are reported as errors rather than handled.
- One EventBridge rule in the stack region only; other regions poll. Organizations / StackSets are not supported.
- Opt-outs are applied immediately, but a sync that already planned the function may re-attach it once; the next sync
  (interval) corrects it.
- Throttle counts lag by up to one poll (5 minutes) plus CloudWatch's own delay; they are per minute, not per request,
  and only for functions Ivy traces. No real-AWS run of the polling yet (aws-sdk-client-mock only).
- Self-hosted Ivy on a laptop needs a public ingest URL (a tunnel) for Lambda to reach the ingest router.
