# Alerts

Slack messages per error group and a weekly email digest. Product decision: `docs/spec/002-product-decisions.md`,
"Alerts". API: `api.md`, "Alerts". Hook: `hooks.md`, `on-error-group-created`.

## What others do (takeaways, November 2026)

- Sentry's issue alerts fire on "a new issue is created" (plus regressions and frequency conditions), throttled per
  issue by an "action interval" (5 min to 30 days; 60 min is a standard choice). Our first seen + 60 min is that shape.
- Sentry has no "every N occurrences" re-alert; counts only gate whether an alert fires. Our 100-occurrence rule is
  cheap with a per-group counter and catches a sudden flood inside the hour.
- Datadog's Error Tracking "new issue" monitors alert once per issue (multi alert by issue) and re-notify on an
  interval; Lumigo's delayed notifications send the first occurrence, then suppress for the delay. Same model.
- Google Cloud Error Reporting caps at 5 notifications per group per hour: throttles are always per group, never global.
- The bigger products (Sentry, Datadog, Lumigo, Better Stack, Baselime) ship OAuth bot apps for interactivity
  (resolve or ignore buttons, threads). Dash0 also offers a plain webhook "if you'd rather not install the app":
  posting only is a respectable first step, and the `incoming-webhook` scope lets the installer pick the channel.
- Slack webhooks: 200 `ok`; 400 `invalid_payload`; 403 `action_prohibited`; 404 `channel_not_found`; 410
  `channel_is_archived`; `invalid_token`/`no_service` when revoked; 429 with `Retry-After` (about 1 message per
  second per channel). Dead webhooks must be detected and shown, not retried forever.
- Of these, only Sentry has a real weekly email (issues, week-over-week change, most frequent issues). A digest of new
  groups, top groups with trend and totals covers what people read.
- Nobody puts payloads in alerts by default; Ivy's payloads may hold personal data, so messages carry only type,
  message, function, counts, a stack frame and a link.
- Not taken over (yet): resolve/ignore state and regressions (Ivy has no issue workflow), Slack threads, per-rule
  routing. Sources: docs.sentry.io/product/alerts, docs.datadoghq.com/error_tracking/monitors, docs.lumigo.io/docs/notifications,
  dash0.com/docs (alerting), betterstack.com/docs/errors/integrations/slack, docs.slack.dev (webhooks, rate limits, app manifest).

## Each channel only when configured

| | needs | `/api/config` |
|---|---|---|
| Slack | `IVY_SLACK_CLIENT_ID`, `IVY_SLACK_CLIENT_SECRET`, `IVY_PUBLIC_URL` (OAuth redirect, links), `IVY_SECRET_KEY` (encryption, signed state) | `alerts.slack` |
| Weekly digest | `IVY_SMTP_URL`, `IVY_EMAIL_FROM`, `IVY_PUBLIC_URL` (links in the email) | `alerts.email` |

Without them nothing is sent, the routes that would need them answer 409, and the dashboard's settings pages say which
variables are missing (`available.missing` / `missing` in the API).

## Slack

**OAuth v2 with only `incoming-webhook`.** "Add to Slack" (owners, Settings → Alerts → project) calls
`POST …/alerts/slack/connect`, which returns `https://slack.com/oauth/v2/authorize?client_id&scope=incoming-webhook&redirect_uri=<IVY_PUBLIC_URL>/api/slack/oauth/callback&state=…`.
The installer picks a channel in Slack; Slack redirects to the callback, which:

1. verifies the state: `base64url(JSON {w: tenant, p: project, u: sub, n: nonce, exp: +10 min}).HMAC-SHA256`, key
   HKDF(`IVY_SECRET_KEY`, purpose `slack-oauth-state`) (`lib/alerts/signing.ts`);
2. checks the `ivy_slack_oauth` cookie (HttpOnly, SameSite=Lax, Path=/api/slack) equals the state's nonce, so the
   flow only completes in the browser that started it (no login CSRF that would attach someone's Slack channel to
   another workspace's project). The dashboard authenticates with bearer tokens, not cookies, so the callback can't
   rely on a session;
3. checks the user still owns the workspace (multi-workspace mode);
4. exchanges the code at `oauth.v2.access` and stores `incoming_webhook.url` encrypted with the auto-trace keys'
   secret box (AES-256-GCM, HKDF from `IVY_SECRET_KEY`), plus channel, channel ID, team name and the
   configuration URL, in `ivy_control.slack_integrations`;
5. redirects to `/w/<ws>/settings/alerts/<project>?slack=connected|denied|error&message=…`.

A project can have several channels (each "Add to Slack" adds one; the same channel again replaces its row).
"Remove" deletes Ivy's row; the webhook stays in Slack until removed there (the configuration URL links to it).

**Messages** (`formatGroupMessage`, Block Kit): heading ("New error in Checkout (prod)" or "Error in …"), error type
(with the failure kind for failures outside the handler: "Out of memory: Runtime.OutOfMemory"), the message trimmed to
280 characters and mrkdwn-escaped, then a context line with the function, project · workspace and counts ("First
seen", or "37 more in the last 60 min · 412 total"), the first stack frame of the latest occurrence (`at handler
(/var/task/index.mjs:12:5)`, never the message line of the stack), and a "View in Ivy" button to the latest trace (or
the errors page of the function for throttles). No payloads, attributes or log lines. A plain `text` fallback for
notifications.

**Delivery** (`postWebhook`): up to 3 attempts; 429 and 5xx (and network errors) are retried, honouring
`Retry-After` up to 30 s; other 4xx are not. 403/404/410, or a body like `invalid_token`, `no_service`,
`channel_not_found`, `channel_is_archived`, mark the channel `broken` with the error: the UI shows it, the evaluator
skips it, and a successful "Send test message" revives it. Messages to one webhook are spaced 1.1 s apart.

## The evaluator

A loop in the API process (`lib/alerts/loop.ts`), every `IVY_ALERTS_INTERVAL_SECONDS` (60):

1. **One evaluator.** The run takes the `alerts` lease in `ivy_control.job_leases`: each process keeps its own row
   (`holder` = host:pid:random, `since`, `expires_at` = now + 3 intervals), and the live row with the oldest `since`
   leads. A process sees a live leader and backs off, or writes its row and reads again, so two that claim at the same
   moment agree on one. ClickHouse has no transactions, so this is best effort: two processes that start within the
   same instant, each reading before the other writes, can both run once. The per-group state below is written before
   sending, which limits the damage to that one overlap. Within a process, runs never overlap. One API process (the
   compose default) needs none of this; several get it for free. Single-instance is all that's needed: the work is
   small.
2. **Work list.** Every project with a working Slack channel (cross-tenant read of `slack_integrations`, reviewed in
   `scoped.test.ts`), skipping archived projects and projects with `slack_enabled = false`. With the
   `on-error-group-created` hook installed: every project.
3. **Candidates.** Per project, one query (`lib/alerts/data.ts`) over `invocations` (status `error`, so failures
   outside the handler are in it) for fingerprints with an occurrence in the last `interval + 15 min`, returning per
   group the total within retention, first and last seen, the latest trace and the count after its last
   notification (`countIf(ts > notified_at[indexOf(fps, fingerprint)])`, 0 for groups without state). With
   `include_throttles` (off by default), the same over `function_throttles` for the synthetic
   `throttled:<region>:<function>` groups. The fingerprints are the error groups' (`errors.ts`, the materialized view).
4. **Decision** (`decide`), per group, with `ivy_control.alert_state` (tenant, project, fingerprint,
   `first_notified_at`, `last_notified_at`, `occurrences_at_last_notify`):
   - no state and first seen after the project's first channel was connected (and within 24 h): **first seen**, send;
   - no state but older: write a baseline state without sending, so connecting Slack doesn't post every existing error;
   - state: send when there are new occurrences and either `every_occurrences` (100) of them or
     `interval_minutes` (60) since the last message, whichever comes first. No new occurrences, no message.
5. **Claim, then send.** The state is written before posting: a crash loses a message rather than sending it twice.
   At most 10 messages per project per run; the rest follow a minute later.

The 15-minute margin covers ingest lag and short restarts. A group whose only occurrences arrive more than 15 minutes
late (by span timestamp) is noticed with its next occurrence.

## Weekly digest

`sendDueDigests` runs in the same loop. The schedule is `IVY_DIGEST_CRON` (five fields, UTC, default `0 8 * * 1`,
Monday 08:00; `lib/alerts/cron.ts`); a run is due when its latest scheduled minute was within the last 24 hours, so a
restart over Monday morning still sends it.

- **Period**: the seven days before 00:00 UTC of the run's day (Monday digest = the previous Monday–Sunday), against
  the seven days before that.
- **Per workspace**, unless switched off (`ivy_control.digest_settings`, owners, default on), already sent for this
  period (`ivy_control.digest_sends`, one row per workspace and period end date, written before sending), without
  recipients, or without data in the period (no invocations and no throttles).
- **Recipients**: multi-workspace mode, the members with an email; single-workspace mode, the users who signed in
  (recorded in `ivy_control.notification_prefs` on their first request per process); plus `IVY_DIGEST_TO` for the
  `default` workspace (installs without sign-in). Minus everyone with `digest = false` there (per user and workspace;
  no row = subscribed).
- **Content** (`renderDigest`): totals of invocations, errors, failures outside the handler and throttles with the
  change against last week; new error groups (first seen in the period, up to 10); the top 10 groups by occurrences
  with their trend; each links to its latest trace (or errors page). Types, trimmed messages, function and project
  names only, no payloads. HTML with tables and inline styles on a light background (email clients don't do the
  dashboard's dark theme reliably; `color-scheme` lets clients that darken mail do so), plus a text part.
- **Unsubscribe**: each email carries `List-Unsubscribe: <…/api/digest/unsubscribe?token=…>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), and the same link in the footer. The token is
  `{t: tenant, s: sub}` signed like the OAuth state (purpose `digest-unsubscribe`, key `IVY_SECRET_KEY`, or the SMTP
  URL when there is none), without expiry, so it works without signing in. GET shows a confirmation button (link
  scanners prefetch GETs), POST unsubscribes. Members switch it back on under Notifications.

## Dashboard

- **Settings → Alerts** (`/w/<ws>/settings/alerts/<project>`): project picker, Slack channels (connect, status,
  "Send test message", remove), and "When an error group is first seen (always), then at most every [60] minutes or
  every [100] occurrences, whichever comes first", the Slack on/off switch and "Also alert on throttles". Owners edit;
  members see it read-only.
- **Settings → Email digest**: on/off (owners), schedule, recipient count, and a preview of this week's email.
- **Notifications** (settings and the user menu): your digest subscription per workspace.
- Without the configuration each page explains which variables are missing. Mock mode: `VITE_MOCK_NO_ALERTS=1`.

These are dashboard-only pages; the MCP App views and the website demo have no settings, so nothing changes there.

## Self-hosting setup

Slack (once per install):

1. https://api.slack.com/apps → *Create New App* → *From an app manifest*; paste
   `deploy/slack-app-manifest.example.yml` with `https://ivy.example.com` replaced by your `IVY_PUBLIC_URL`.
   The manifest asks only for `incoming-webhook` (as a bot scope, where Slack's manifest format puts it), no bot
   user, events or interactivity, token rotation off.
2. *Basic Information → App Credentials*: Client ID → `IVY_SLACK_CLIENT_ID`, Client Secret →
   `IVY_SLACK_CLIENT_SECRET`. Set `IVY_PUBLIC_URL` and `IVY_SECRET_KEY` (`openssl rand -base64 32`) if not set yet.
   Restart the API.
3. Other Slack workspaces: *Manage Distribution → Public Distribution* (not part of the manifest).
4. Ivy → Settings → Alerts → *Add to Slack* → choose a channel → *Send test message*.

Digest: set `IVY_SMTP_URL`, `IVY_EMAIL_FROM`, `IVY_PUBLIC_URL`; optionally `IVY_DIGEST_CRON` and `IVY_DIGEST_TO`.

## Configuration

| variable | default | |
|---|---|---|
| `IVY_SLACK_CLIENT_ID`, `IVY_SLACK_CLIENT_SECRET` | | the Slack app; Slack is off without them |
| `IVY_PUBLIC_URL` | | OAuth redirect and links in messages and emails; required for both |
| `IVY_SECRET_KEY` | | encrypts webhook URLs, signs the OAuth state and unsubscribe links; required for Slack |
| `IVY_SMTP_URL`, `IVY_EMAIL_FROM` | | the digest (and invitations) |
| `IVY_DIGEST_CRON` | `0 8 * * 1` | digest schedule, UTC |
| `IVY_DIGEST_TO` | | extra recipients of the `default` workspace's digest, comma-separated |
| `IVY_ALERTS_INTERVAL_SECONDS` | `60` | evaluator period; `0` turns alerts and the digest off in that process |
| `IVY_SLACK_API_URL`, `IVY_SLACK_AUTHORIZE_URL` | Slack's | for tests only |

If `IVY_SECRET_KEY` changes, stored webhooks can't be decrypted: the channels show as broken and need reconnecting.

## Verification

- `lib/alerts/evaluate.test.ts`, against a fake Slack webhook server (`lib/alerts/testing.ts`, real HTTP): first
  seen, nothing in between, the 60-minute message with its count, 100 occurrences inside the hour, custom thresholds,
  the on/off switch, no flood of existing groups on connect, throttles only when enabled, failures outside the
  handler, several channels and the per-run cap, a 404 `channel_not_found` marking the channel broken, 429 with
  `Retry-After` then 503 then delivery, no Slack configuration, overlapping runs in one process and across two
  "processes" (one message, lease handover after expiry), and `on-error-group-created` firing once with its envelope.
- `routes/alerts/alerts.test.ts` (OIDC test issuer, fake Slack): env gating of `/api/config` and the routes, owner-only
  settings and validation, the authorize URL and cookie, the callback storing the webhook encrypted (`v1.…`, decrypts
  to the URL, never returned by the API), reconnecting the same channel, a second channel, missing/forged/expired
  state and a missing cookie (400, no code exchange), cancelled, Slack refusing the code, an owner demoted mid-flow,
  test message, broken on `invalid_token`, remove.
- `lib/alerts/slack.test.ts`: message content and trimming, escaping, no payloads or logs whatever the input,
  throttle links, first-frame extraction, signed tokens (tamper, purpose, secret, expiry), cron.
- `routes/digest/digest.test.ts`, against an SMTP catcher (`lib/email/testing.ts`, the real nodemailer transport):
  schedule, recipients, subject, both parts, totals and trends, new and top groups, links, `List-Unsubscribe` and
  its token, once per period across "processes" and restarts, late delivery, skipping empty or switched-off
  workspaces or missing SMTP, `IVY_DIGEST_CRON`, the unsubscribe page and one-click POST, re-subscribing under
  Notifications, workspace settings and preview.
- `lib/alerts/data.test.ts`: every alert query binds the tenant and project (the digest explicitly all projects).
  The SQL was also run against a throwaway ClickHouse 26.8 with the schema applied and seeded rows (groups, the
  since-notify count, throttles, the stack frame, digest totals and trends).
- UI: `lib/mock/alerts.test.ts` (mock API states, schedule wording), and the pages checked in Chrome on the mock API
  with and without `VITE_MOCK_NO_ALERTS`.

## Gaps

- No resolve/ignore and no regression detection: a group that stops and comes back weeks later gets the "60 minutes
  passed" message, not "regressed".
- The lease is best effort (see above), and notification hooks are at-most-once.
- Stack frames are read from the latest occurrence's spans only when a message is sent (one small query).
- The digest uses the server's English and UTC; no per-user time zone.
