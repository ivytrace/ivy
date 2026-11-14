# Auto-trace: connecting AWS accounts (M4)

Users connect an AWS account from **Settings → AWS accounts**. Ivy then attaches the Node.js layer to every
supported function in that account, including new ones, and keeps it attached. Code lives in
`packages/api/src/lib/aws/` and `packages/api/src/routes/aws/`, the UI in `packages/ui/src/routes/settings/` and
`packages/ui/src/components/aws/`.

## Flow

1. **Connect.** The user enters the 12-digit account ID, a stack region and the regions to trace. `POST /api/aws/accounts`
   creates a *pending* connection with a random external ID (`ivy-<32 hex>`), an event secret, and a deterministic
   role name `IvyTrace-<8 hex>` (so the role ARN is known before the stack exists). It returns a CloudFormation
   quick-create URL, or `null` when no template URL is configured (see below).
2. **Deploy.** The user opens the quick-create link in a new tab (signed in to the target account), ticks the IAM
   acknowledgement and creates the stack. Without a template URL, the UI offers "Download template" (defaults for this
   connection filled in) plus "Upload a template file" instructions.
3. **Verify.** The UI calls `POST /api/aws/accounts/:id/verify` every 10 s once the user has opened the link or download,
   and on "I've deployed it, verify". Verify calls `sts:AssumeRole` with the external ID. The first success marks the
   account *connected* and starts the first sync. A failure keeps it *pending* and shows the STS error.
4. **Sync.** For each region: `ListFunctions` (paginated) and `tag:GetResources` for tags, then a plan per function (below),
   `PublishLayerVersion` if needed, `UpdateFunctionConfiguration` for functions that change, and one batch of status
   rows into ClickHouse. Traces arrive after each function's next invocation, so the 5-minute target is mostly the
   stack deploy (~1 min) plus the first sync (seconds).
5. **Stay in sync.** A background loop in the API process re-syncs every connected account every
   `IVY_AWS_SYNC_INTERVAL_SECONDS` (default 300). Optionally, EventBridge pushes function changes for an immediate sync.
6. **Opt out.** The per-function toggle stores a setting and applies it to that function right away (detach or attach).
   Disconnecting an account detaches the layer from all its functions first (unless `detach=false`) and then tells the
   user to delete the stack.

## Decisions

### Where config lives: three small ClickHouse tables

No new datastore. `deploy/clickhouse/schema.sql` adds (all `CREATE TABLE IF NOT EXISTS`, `tenant_id` first in `ORDER BY`):

| table | engine | key | |
|---|---|---|---|
| `aws_accounts` | `ReplacingMergeTree(updated_at)` | `(tenant_id, id)` | one row per connection: role ARN, external ID, event secret, regions, status, last error, timestamps, `deleted` flag |
| `aws_functions` | `ReplacingMergeTree(updated_at)` | `(tenant_id, account_id, region, function_name)` | last known state per function: `traced`/`opted_out`/`unsupported`/`conflict`/`error`/`pending` + reason |
| `aws_function_settings` | `ReplacingMergeTree(updated_at)` | `(tenant_id, account_id, region, function_name)` | the dashboard opt-out (`tracing_enabled`) |

- Every update inserts a full row; reads use `FINAL` and `NOT deleted`. Deleting inserts a row with `deleted = 1`.
  The store gives each write a version strictly above its previous one, so two writes in the same millisecond keep
  their order.
- Settings are keyed by AWS account ID (not connection ID) so opt-outs survive disconnecting and reconnecting.
  They are kept apart from `aws_functions` so a sync that read a function before a toggle can't overwrite the toggle.
- Read-modify-write races (a sync finishing while the user edits regions) are narrowed by re-reading the account right
  before saving sync results; the worst case is a lost `last_sync_at`/`error` update that the next sync rewrites.
- Volumes are tiny (rows per function, rewritten once per sync interval), well within what ReplacingMergeTree merges away.
- The layer version per account/region is not stored: it is found again with `ListLayerVersions` (cached in memory).

### AWS identity

Ivy only uses the AWS SDK as a client; nothing of Ivy runs in AWS.

- Ivy's own credentials come from the standard SDK chain (env vars, shared config/`AWS_PROFILE`, container/instance role).
  Hosted uses Ivy's own principal; self-hosters bring an IAM user or role.
- The **trusted principal** in the template comes from `IVY_AWS_PRINCIPAL_ARN`. If unset, Ivy derives it from
  `sts:GetCallerIdentity` (an assumed-role session ARN maps back to `arn:aws:iam::<acct>:role/<name>`). If neither works,
  `GET /api/aws/setup` reports it as an issue and the template has no default for the parameter.
- `AssumeRole` goes to the regional STS endpoint of `IVY_AWS_REGION`/`AWS_REGION` (default `us-east-1`); regional STS
  tokens are valid in opt-in regions too. Credentials are cached per role until 5 minutes before expiry.
- The **external ID** is unique per connection (`randomBytes(16)`), and is a template parameter, as is the principal.

### The template

`buildTemplate()` in `lib/aws/template.ts`, served as YAML by `GET /api/aws/template.yaml`.

- Parameters: `TrustedPrincipalArn`, `ExternalId`, `RoleName`, `EventsUrl` (optional), `EventSecret` (`NoEcho`).
  Without `?account=` the template is generic (only the principal has a default): that's the file to publish to S3.
  With `?account=<id>` all defaults are filled in for the download-and-upload path.
- Role policy (least privilege): `lambda:ListFunctions`, `GetFunction`, `GetFunctionConfiguration`,
  `UpdateFunctionConfiguration`, `ListLayerVersions` and `tag:GetResources` on `*`; `PublishLayerVersion` and
  `GetLayerVersion` only on `arn:…:lambda:*:<acct>:layer:ivy-trace-nodejs[:*]`. Trust: the principal, with an
  `sts:ExternalId` condition. The role is tagged `ivy:component`.
- The template has to be at an S3 URL for a quick-create link. `IVY_CFN_TEMPLATE_URL` configures it; the API builds
  `https://<stack-region>.console.aws.amazon.com/cloudformation/home?region=…#/stacks/quickcreate?templateURL=…&stackName=…&param_…`.
  Hosted will publish the generic template to a public bucket. Self-hosters can do the same:
  `curl https://ivy.example.com/api/aws/template.yaml > ivy-trace.yaml && aws s3 cp ivy-trace.yaml s3://bucket/ --acl public-read`
  (or a bucket policy), then set `IVY_CFN_TEMPLATE_URL`. Without it the UI shows the download fallback.
- Checked with `cfn-lint` in `template.test.ts` (runs when `cfn-lint` is on the PATH) and by structure assertions.

### Getting the layer into the account

`PublishLayerVersion` of the zip that ships in the API image (`/app/layer.zip`, built by `packages/api/Dockerfile`; in
development `packages/layer/dist/layer.zip`; override with `IVY_LAYER_ZIP`) into each account and region, as
`ivy-trace-nodejs`, through the assumed role. No public or cross-account layers needed, the same for hosted and
self-hosted. The description carries `sha256:<zip hash>`; before publishing Ivy looks for a version with the same hash,
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
  (`<public url>/api/aws/events`) and `EventSecret` are filled in and the stack also creates an EventBridge connection
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
3. Tag `ivy:trace=false` or the dashboard toggle off → `opted_out`; if attached, remove the Ivy layer, `IVY_ENDPOINT`,
   `IVY_API_KEY`, and `AWS_LAMBDA_EXEC_WRAPPER` only when it is `/opt/ivy-wrapper`. Other variables (including
   other `IVY_*` such as `IVY_REDACT_KEYS`) and layers stay.
4. Environment unreadable (`Environment.Error`, e.g. a KMS key the role can't use) → `error`; never write variables Ivy
   couldn't read, since `UpdateFunctionConfiguration` replaces them all.
5. `AWS_LAMBDA_EXEC_WRAPPER` set to something else → `conflict`. Five non-Ivy layers already → `conflict`.
6. No ingest config → `pending`. Otherwise: desired layers = existing non-Ivy layers + the current Ivy layer version
   (older Ivy versions replaced), desired env = existing + `AWS_LAMBDA_EXEC_WRAPPER=/opt/ivy-wrapper`,
   `IVY_ENDPOINT=$IVY_INGEST_PUBLIC_URL`, `IVY_API_KEY=$IVY_INGEST_API_KEY`. Equal to current → no call. → `traced`.

Applying: `ResourceConflictException` (an update in progress) is retried after 2, 4, 8 and 16 s. If tags could not be
read (`tag:GetResources` denied), Ivy does not attach to functions that would change, since one of them could carry
the opt-out tag; they show as `pending`. In "all enabled regions" mode, regions that reject the credentials
(`UnrecognizedClientException` etc., i.e. not enabled) are skipped silently; with explicit regions they're reported.

Ingest config is single-tenant for now (`ingestConfig(tenant)` returns the env values); M6 maps tenants to their keys.

## API

See `api.md` (`/api/aws/*`).

## Configuration (API)

| variable | | |
|---|---|---|
| `IVY_INGEST_PUBLIC_URL` | required to attach | collector URL reachable from Lambda, e.g. `https://ingest.example.com` (the OTLP/HTTP base, without `/v1/traces`) |
| `IVY_INGEST_API_KEY` | required to attach | the ingest key written into functions (`dev-ingest-key` in compose) |
| `IVY_AWS_PRINCIPAL_ARN` | recommended | principal customers trust; derived from the credentials if unset |
| AWS credentials | required | standard SDK chain: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`, `AWS_PROFILE`, or a role |
| `IVY_CFN_TEMPLATE_URL` | optional | S3 URL of the generic template; enables one-click quick-create links |
| `IVY_PUBLIC_URL` | optional | public `https://` URL of the API; enables the EventBridge part of the template |
| `IVY_AWS_DEFAULT_REGION` | `us-east-1` | default stack region in the connect dialog |
| `IVY_AWS_REGION` | `AWS_REGION` or `us-east-1` | region of the STS endpoint |
| `IVY_AWS_SYNC_INTERVAL_SECONDS` | `300` | polling interval; `0` disables the background loop |
| `IVY_LAYER_ZIP` | `/app/layer.zip` in the image | layer zip to publish |

## Verification

- `packages/api`: `attach.test.ts` (plan rules), `template.test.ts` (YAML round trip, structure, cfn-lint, quick-create URL),
  `sync.test.ts` (layer reuse/publish, conflict retry, revision conflicts, unreadable tags, disabled regions, removed
  functions, single-function toggle, detach) and `routes/aws/aws.test.ts` (all routes end to end with an in-memory
  store), all with `aws-sdk-client-mock`; no AWS account involved.
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
- Self-hosted Ivy on a laptop needs a public ingest URL (a tunnel) for Lambda to reach the collector.
