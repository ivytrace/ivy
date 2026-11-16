# Product decisions (v1)

Decisions made after the v1 plan (001). Where they differ from 001, this document wins. Implementation details
live in `docs/implementation/`.

## Product and brand
- The product is called **Ivy**. "ivytrace" is only for domains (ivytrace.dev) and GitHub/npm org names.
- Dark mode only, for the app, the MCP App views and the website. No light theme, no theme toggle.
- One visual language across the dashboard, the MCP App views and the website's demo: zinc neutrals, the logo's
  green (`#4ade80`) as the accent for buttons and links. A visual change to one surface is applied to all of them.
- There is also a hosted version of Ivy at ivytrace.dev. Its website, prices and infrastructure are not part of
  this repository.

## Repositories
- `ivytrace/ivy` (public) holds the open-source product: layer, API, dashboard, MCP server, deploy files.
- This repository contains nothing specific to the hosted service: no prices or plans, no payment provider, no
  hosted infrastructure, no hosted-only identity provider or domain configuration.
- No AI-tool attribution in commits or pull requests.
- `ivy` is MIT licensed.
- Storage uses the OpenTelemetry Collector's ClickHouse exporter rather than a custom exporter (see
  `docs/implementation/storage.md`).

## Accounts, workspaces and projects
- Users belong to **workspaces** (visible: create, switch, invite teammates). A workspace owns members, billing,
  connected AWS accounts and its storage shard.
- Workspaces contain **projects**. Every function belongs to exactly one project; ingest keys and alert rules
  belong to a project.
- **Environments are separate projects** (`checkout-prod`, `checkout-staging`).
- An AWS account connects to a workspace and can feed several projects.
- **Slugs are generated from names and hidden; URLs stay stable when renaming.** Creating a workspace or project
  asks for a name only; collisions get `-2`, `-3`. Changing a URL is a separate "Change URL" action under Advanced.
- URLs carry workspace and project (`/w/<workspace>/<project>/…`); old links redirect to the last-used project.
- A workspace you're not a member of looks exactly like one that doesn't exist.
- Owners manage the workspace, members and invitations; members can do everything else.
- Invitations are links (also emailed when SMTP is configured), single use, valid 7 days, and only accepted by a
  signed-in user whose email matches and is verified by the identity provider.
- Self-hosted without sign-in, or with `IVY_SINGLE_TENANT` on, has one workspace and no member management.
- Moving a function to another project affects only new data; data already ingested stays where it is.
- There is no default project: every key, rule and traced function belongs to an explicit project.
- **"All projects"** is a scope of its own: Functions (with its charts), Invocations and Errors work across every
  project of the workspace, each row labelled with its project and linking into it. It is the first entry of the
  project switcher and can be the remembered last choice. A single trace always lives in one project.
- **All projects is the default selection.** Without a remembered last-used project for a workspace (first visit, a new
  workspace, cleared storage), Ivy opens that workspace's All projects; a remembered project still wins. Skipping the
  quick-start wizard lands on All projects; finishing it after the first trace arrived lands on that trace's project.

## Authentication
- Dashboard, API and MCP: **either no auth or OIDC**, never passwords or basic auth, not even temporarily.
  Without OIDC configured, the UI shows a persistent "authentication disabled" banner.
- Any OIDC provider works. Coding agents and MCP clients sign in through it on the user's behalf where the provider
  supports it: agents with device-flow registration (the user's email passed as `login_hint`), MCP clients with the
  MCP authorization spec.
- Ingest always requires an API key, and the key alone decides which workspace and project data lands in.

## Auto-tracing
- **Opt-in.** Connecting an AWS account traces nothing by itself. Ivy lists the account's functions grouped by
  CloudFormation stack; the user picks stacks or name/tag patterns, and that choice is saved as a rule that also
  names the project. New functions matching a rule are traced automatically.
- Lambda tags `ivy:trace=true|false` and `ivy:project=<slug>` override rules.
- **Force install over another tracer.** A function whose `AWS_LAMBDA_EXEC_WRAPPER` belongs to another tracer is a
  "Conflict". The user can force-install Ivy from the conflict's tooltip, after a confirmation that says the other
  tracer (named when the wrapper path gives it away, e.g. Lumigo) will most likely stop tracing the function. Ivy
  then replaces the wrapper and adds its layer, leaving the other tracer's layer and variables alone. The choice is
  kept per function, so later syncs don't flip it back. When Ivy stops tracing the function (rule, tag, exclude,
  disconnect), it restores the previous wrapper. Excluding the function also drops the force choice.
  `ivy:trace=false` still wins over force. If the other tracer sets its wrapper back (e.g. its own auto-trace
  integration), Ivy doesn't fight it: it removes its layer, shows a distinct "set back" conflict, and only forces
  again when the user asks.
- The CloudFormation quick-create link must not carry secrets. A deployment can publish each connection's template
  through a hook; without that hook Ivy offers a template download.

## Agents (AI-native)
- No CLI. Agents use the **MCP server** or the **HTTP API** (with an OpenAPI spec).
- The MCP server covers **all of the user's workspaces** at once; every result says which workspace it is from.
- MCP App tools `render_waterfall` and `render_graph` show the real trace views inside the chat; they are
  shipping features, not experiments.
- Onboarding starts from one short prompt on the website that points the agent to `llms.txt`. The agent signs the
  user up, creates the workspace and project, connects AWS, picks what to trace and verifies the first trace.
  At the end it offers to add the Ivy agent skill, an `AGENTS.md` pointer and the MCP server config to the repo.
- Lambda spans are sent per invocation; no batching across invocations (it would delay traces while debugging).

## Failures outside the handler
- Ivy shows failures outside the handler (init errors, crashes, OOM, timeouts) and throttles; it never ships full
  function logs. Only a failure adds data (its last log lines, at most 50 lines / 8 KB); a healthy invocation gets
  a few attributes and no extra invocation. Throttle polling uses CloudWatch in the customer's account, is on by
  default and can be switched off per account (see `docs/implementation/platform-failures.md`).

## Hooks
- The backend runs optional executables from a hooks directory, git-hooks style: notification hooks
  (`on-<noun>-<past-tense>`, async, result ignored) and provider hooks (`<verb>-<noun>`, return a result, with a
  built-in fallback). Deployment-specific behaviour goes into hooks, not into Ivy itself.

## Billing
- Billing is per **workspace**, counted in traces; one trace is one Lambda invocation.
- The open-source product has no payment code and only knows generic per-workspace limits: no limits set means
  unlimited, so self-hosted is unlimited. A deployment can plug in billing with `IVY_BILLING_URL` (the dashboard's
  Upgrade / Manage billing buttons), the internal admin API and hooks (for example `on-workspace-created` to set
  limits on new workspaces, with a scheduled reconcile as a safety net).
- Usage is counted per calendar month in UTC. A workspace whose limits block at its quota is **rejected at ingest**
  (HTTP 429 with `Retry-After` and an upgrade link), not silently dropped; a workspace whose limits allow overage
  is never blocked. Enforcement may overshoot by a little (seconds of traffic); invoices use the stored count.
- The dashboard shows usage per workspace with a warning at 80% and at 100% of the quota, and Upgrade / Manage
  billing buttons only where a billing service is configured.

## Dashboard
- First visit: a quick-start wizard (workspace, project, connect AWS and pick functions, wait for the first trace).
- Keyboard shortcuts and a ⌘K command menu across the app.
- The dashboard works on phones: below tablet width the header is a compact bar (logo, project switcher, search, menu)
  with a full-height menu sheet for pages, workspace and project, time range and account; Invocations and Errors show
  card rows, other tables scroll inside their box, and nothing scrolls the page sideways. Desktop is unchanged.
- A "Live" toggle on the Invocations page (`?live=1`) shows new invocations as they arrive and updates running ones in
  place; it pauses on a hidden tab, while scrolled down or paging, and after 15 minutes idle.
- Invocations can be searched by span attribute: `job.id=abc123` in the search box (and in the MCP
  `search_invocations` tool) finds the invocations where the invocation span or any span inside it, such as one a
  handler creates per SQS record with `@opentelemetry/api`, has that attribute with exactly that value. Values match
  as text (numbers and booleans too), can be quoted (`job.reason="manual retry"`), several terms must all match, and
  they combine with the free-text search.

## Performance
- Cold-start overhead of the layer must be minimal: the Lambda extension is a small Rust binary (the one exception
  to TypeScript everywhere).

## Large invocations
- An invocation always shows up in Ivy, even when its spans are too many to keep; repetitive calls are summarised.
- The invocation span is exported first, on its own, so a failed or dropped export of its children never takes it
  along. Children go in chunks; the time spent exporting after the response stays bounded (it is billed to the
  customer). What is left out is said on the trace ("N spans omitted") and in one line in the function's logs.
- Each invocation has a payload budget (1 MB): the invocation's own event and response first, then failing spans,
  then the slowest; spans past it keep their timing and attributes but not their bodies.
- A payload over the per-payload cap is still shown as a JSON tree: the layer shortens long strings and arrays
  so what it stores stays valid JSON, and payloads cut mid-text (older layers, the MCP views' cap) are repaired
  when read, with a muted "… truncated" where the cut was.
- Long-running invocations appear as in progress while they run. After 5 s (`IVY_INPROGRESS_AFTER_MS`, 0 turns it
  off) the extension sends one small provisional record, refreshed every minute; the final invocation always
  replaces it and it is never counted or billed as a trace. Without a final record past the deadline it shows as
  "No completion recorded". Shorter invocations cost nothing extra. Implementation: `docs/implementation/layer.md`.

## Redaction
- Credentials are redacted inside JSON-string request and response bodies too: the `body` string of API Gateway, ALB and
  Function URL events and return values (and SQS records) is parsed, and `accessToken`, `refreshToken`, `idToken`,
  `access_token` and other matching keys become `"[redacted]"`, in the tracer before data leaves the function. The
  body stays a JSON string; base64-encoded and non-JSON bodies are left as they are.
  Implementation: `docs/implementation/span-conventions.md`.

## LLM spans
- Ivy captures OpenTelemetry spans from libraries such as the Vercel AI SDK and renders LLM calls (messages,
  tool calls, tokens, time to first token). This replaces 001's "LLM-call instrumentation: not in v1".
- The layer captures them without an OpenTelemetry SDK and steps aside when the app registers its own tracer
  provider. LLM attributes are normalized when read (`@ivy/spans`), not at ingest, so stored spans stay as the
  producer sent them. Implementation: `docs/implementation/llm-spans.md`.
- Direct Amazon Bedrock calls render as LLM calls: AWS SDK `BedrockRuntime` `InvokeModel`/`Converse` (and their
  streaming variants) show the conversation, response, tool calls, tokens and stop reason like AI SDK and GenAI
  spans, also for spans already stored by older layers. A generic AWS span is never titled by its region.
- Token counts are not secrets: redaction keeps `max_tokens`, `input_tokens`, `inputTokens`, … while `token`,
  `accessToken`, `sessionToken` and the like stay redacted.

## Tagging invocations

- Apps tag an invocation with the standard OpenTelemetry API, our equivalent of execution tags:
  `trace.getActiveSpan()?.setAttribute("user.id", id)` (or `setAttributes`) inside a traced handler writes to the
  invocation span when no library span is active. No Ivy SDK or import is needed beyond `@opentelemetry/api`. The
  values follow the payload rules (redaction by key, size caps), cannot overwrite the layer's own attributes
  (reserved namespaces such as `faas.*`, `ivy.*`, `cloud.*`, `aws.*`, `http.*` are ignored), and are stored as
  ordinary span attributes, so attribute search covers them. `setStatus(ERROR)` marks the invocation as failed;
  `addEvent`/`recordException` add events. The dashboard's invocation Overview, the timeline's invocation row and
  the MCP App views list them as "Attributes"; `@ivy/format` puts them under the trace header. Not available when
  the app registers its own OpenTelemetry context manager. Implementation: `docs/implementation/llm-spans.md`.

## Alerts
- Alerts: Slack per error group (first seen, then at most every 60 min or 100 occurrences, customizable per project)
  and a weekly email digest; each only when configured. This replaces 001's "alerting beyond a webhook on new error
  groups: not in v1".
- Slack connects through Ivy's Slack app with only the `incoming-webhook` scope ("Add to Slack" per project; the
  installer picks the channel). Throttles alert only when a project turns them on.
- Alerts and the digest never carry payloads: type, trimmed message, function, counts, a stack frame and links.
- The digest goes to a workspace's members every Monday 08:00 UTC by default, skips weeks without data, can be
  switched off per workspace by owners, and every member can unsubscribe (one click in the email, no sign-in).
- Notification settings live on one page per workspace (Settings → Notifications): the workspace's digest switch
  (owners), your own digest subscription (everyone), and each project's Slack status with a link to its Alerts
  settings. No separate "Email digest" page and no Notifications entry in the user menu; old URLs redirect.
- The digest lists Lambda functions first seen that week in the workspace's AWS accounts that nothing traces yet (at
  most three names, then "and N more", with a "Choose what to trace" link); left out when there are none or no
  account is connected, and never listing functions excluded in the dashboard or tagged `ivy:trace=false`.
- Errors with the same type, code location and message pattern are grouped; variable parts of the message (IDs,
  paths, numbers) don't split groups. The errors page shows the pattern with the number of distinct messages and the
  most frequent ones; alerts and the digest show the pattern too. A group whose occurrences all have the same message
  shows that message instead of the pattern, everywhere. Implementation:
  `docs/implementation/error-grouping.md`.
- Self-hosters get the `on-error-group-created` hook for their own integrations. Implementation:
  `docs/implementation/alerts.md`.
