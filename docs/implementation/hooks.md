# Hooks

Executable hooks, in the style of git hooks, let a deployment extend what Ivy does at a few control-plane
moments without changing Ivy: hosted uses them to publish CloudFormation templates to S3 and to apply plan
limits to new workspaces; self-hosted installs need none. This document is normative. Code:
`packages/api/src/lib/hooks/` (`run.ts`, and `types.ts` with the payload types).

## Principles

- **Hooks may set policy** (for example, hosted uses `on-workspace-created` to apply plan limits), **but Ivy itself
  never assumes a hook ran.** Notification hooks are at-most-once, so a deployment that relies on one for policy
  must also reconcile on a schedule. **Authentication and authorization never depend on hooks.**
- Public Ivy has no plans or limit defaults: no limits row means unlimited.
- Hooks are for rare control-plane events only, never on ingest, query or quota hot paths.
- No `pre-`/veto hooks in v1: a hook can't stop an action.

## Two kinds

| kind | name | when | result | timeout |
|---|---|---|---|---|
| **Notification** | `on-<noun>-<past-tense-verb>` | asynchronously, after the action has committed | ignored | 30 s |
| **Provider** | `<verb>-<noun>` | synchronously, when Ivy needs something it can't do itself | used | 10 s |

- **Notification hooks** are fire-and-forget: the request that caused them has already been answered (or doesn't
  wait), they run at most once (no retries in v1; a crash or restart in between loses the event), and nothing they do
  or return changes the action.
- **Provider hooks** return a result. Every provider hook has a documented built-in fallback that applies when the
  hook is absent or fails.

## Events

| hook | kind | fired | `data` | result | fallback |
|---|---|---|---|---|---|
| `publish-cfn-template` | provider | when an AWS connection is shown (cached, see below) | `PublishCfnTemplateData` | `PublishCfnTemplateResult` | no quick-create link; download the template |
| `on-workspace-created` | notification | a workspace was created (`POST /api/workspaces`, or a user's personal workspace on first sign-in) | `WorkspaceCreatedData` | | |
| `on-member-joined` | notification | a user accepted an invitation and became a member (not when they already were one) | `MemberJoinedData` | | |
| `on-aws-account-connected` | notification | verifying an AWS connection succeeded for the first time | `AwsAccountConnectedData` | | |

Payload types (`lib/hooks/types.ts`):

```ts
interface WorkspaceRef { id: string; slug: string; name: string }
interface UserRef { sub: string; email: string | null }   // sub = the OIDC subject

// publish-cfn-template
interface PublishCfnTemplateData {
  workspace: WorkspaceRef;
  connection: { id: string; account_id: string; stack_name: string; stack_region: string };
  template: string;   // YAML, with this connection's values as defaults, including its event secret
}
interface PublishCfnTemplateResult {
  url: string;          // https:// URL CloudFormation can fetch: in practice an S3 URL, e.g. pre-signed
  expires_at?: string;  // ISO 8601; Ivy re-publishes 5 minutes before. Without it the URL is reused for 10 minutes
}

// on-workspace-created
interface WorkspaceCreatedData { workspace: WorkspaceRef; owner: UserRef }

// on-member-joined
interface MemberJoinedData {
  workspace: WorkspaceRef;
  member: UserRef & { role: 'owner' | 'member' };
  invitation_id: string;
  invited_by: UserRef | null;
}

// on-aws-account-connected
interface AwsAccountConnectedData {
  workspace: WorkspaceRef;
  connection: { id: string; name: string; account_id: string; stack_region: string; regions: string[]; all_regions: boolean };
}
```

Payloads carry IDs, slugs, names and emails, never trace data or access tokens. The only secret any payload carries
is the CloudFormation template's event secret, which `publish-cfn-template` needs by its nature.

### `publish-cfn-template` in detail

Ivy renders one template per AWS connection with every value filled in as a parameter default (trusted principal,
external ID, role name, events URL, and the event secret as a `NoEcho` parameter). With the hook, Ivy hands it the
template and builds the quick-create link from the returned URL alone:

```
https://<region>.console.aws.amazon.com/cloudformation/home?region=<region>#/stacks/quickcreate?templateURL=<url>&stackName=<stack>
```

The link has no `param_…` values, so no secret is in it (the secret is only in the template behind the URL, which
should be short-lived). Results are cached per connection and template content until 5 minutes before
`expires_at`; failures for 30 s. CloudFormation only loads quick-create templates from Amazon S3 URLs.

- Absent: download-only mode. `GET /api/config` says `"aws": { "quick_create": false }`; accounts have
  `quick_create_url: null`; the UI offers "Download template" (the authenticated
  `GET /api/w/:workspace/aws/template.yaml?account=…`) and the steps to upload it in the CloudFormation console.
- Failing (non-zero exit, timeout, bad output, a `url` that isn't `https://`): the same, plus
  `quick_create_error` on the account with a message the UI shows.

## Contract

**Location.** `IVY_HOOKS_DIR` (default `/etc/ivy/hooks`). A hook is a file named exactly after the event, directly in
that directory: a regular file or a symlink to one, executable by the API's user. Names are checked against
`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, so there's no path traversal. If the file is absent or not executable, the hook
counts as absent. Hooks are looked up on every call, so adding or removing one needs no restart.

**Input.** One JSON object on stdin, then stdin is closed:

```json
{ "version": 1, "hook": "on-workspace-created", "id": "hk_3RkP…", "timestamp": "2026-11-14T15:00:00.000Z",
  "instance": "https://ivytrace.dev", "data": { … } }
```

`id` is unique per run and appears in Ivy's log lines for it. `instance` is `IVY_PUBLIC_URL`, or the host name.

**Output.** Exit 0 means success. A provider hook prints `{ "version": 1, "result": { … } }` on stdout; a bare result
object (`{ "url": "…" }`) is also accepted. Anything else (no JSON, an array, `version` other than 1, a non-object
`result`) is a failure. Notification hooks' stdout is ignored. stdout is capped at 1 MB (more is a failure); stderr
(the first 64 KB) is logged line by line as `[hook <name> <id>] …`.

**Execution.** `execve` of the file itself (no shell, no arguments), with the hooks directory as working directory, in
its own process group. On timeout the whole group gets `SIGKILL`, so anything the hook started dies with it.

**Environment.** Only: `PATH`, `HOME`, `IVY_HOOKS_DIR`, `IVY_PUBLIC_URL`, and every `AWS_*` and `HOOK_*` variable of
the API process. Configure your hooks with `HOOK_*` variables (e.g. `HOOK_CFN_BUCKET`). Nothing else is passed; in
particular none of Ivy's secrets (`IVY_SECRET_KEY`, `IVY_COLLECTOR_TOKEN`, ClickHouse credentials, SMTP URL, …).
`AWS_*` is passed because the publish hook typically needs credentials.

**Failure.** A failing provider hook means its fallback; a failing notification hook is only logged. Neither fails
the request.

**Observability.** Every run logs one line: `[hook <name> <id>] ok (<ms> ms)` or `… failed: <reason> (<ms> ms)`. Counts
per hook since start (`{ runs, ok, failed }`) are on the API's internal stats endpoint:
`http://127.0.0.1:3020/stats` → `{ "hooks": { "publish-cfn-template": { "runs": 3, "ok": 3, "failed": 0 } } }`
(`IVY_API_ADMIN_PORT`, `IVY_API_ADMIN_HOST`; loopback only, like the ingest router's).

## Examples

Shell notification hook (`deploy/hooks.example/on-workspace-created`):

```sh
#!/bin/sh
set -eu
event=$(cat)
echo "workspace created: $event" >&2
```

Node provider hook (`deploy/hooks.example/publish-cfn-template`, abridged): writes the template into a directory a web
server serves and returns its URL. For real quick-create links, publish to S3 instead (see the comment in the file).

```js
#!/usr/bin/env node
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const name = `${event.data.connection.id}-${crypto.randomUUID()}.yaml`;
fs.writeFileSync(path.join(process.env.HOOK_CFN_DIR, name), event.data.template);
process.stdout.write(JSON.stringify({ version: 1, result: { url: `${process.env.HOOK_CFN_BASE_URL}/${name}` } }));
```

In Docker, mount a directory and point `IVY_HOOKS_DIR` at it (the API image has `/bin/sh` and `node`):

```yaml
services:
  api:
    environment: { IVY_HOOKS_DIR: /etc/ivy/hooks, HOOK_CFN_BUCKET: my-bucket }
    volumes: ["./hooks:/etc/ivy/hooks:ro"]
```

**Testing a hook:** `pnpm --filter @ivy/api hooks:test <name> [data.json]` (in the image: `node hooks-test.mjs <name>`)
runs it with a sample `data` payload (or yours) exactly as the API would and prints the outcome.

## Verification

`lib/hooks/run.test.ts`: discovery (absent, not executable, symlink, invalid names), the envelope on stdin and the
working directory, provider results (wrapped and bare), invalid output, non-zero exit, timeout killing the process
group (a background child of the hook doesn't survive), the environment allow-list, notifications running after the
caller continues and never throwing, run counts, and `on-workspace-created` firing from `createWorkspace`.
`routes/aws/aws.test.ts`: download-only without the hook, a quick-create link built from the hook's URL with no
`param_…`, external ID or event secret in it (the template the hook received has them as defaults), and the
fallback with a message when the hook fails or returns no `https://` URL. The example hooks were run with
`hooks:test`.
