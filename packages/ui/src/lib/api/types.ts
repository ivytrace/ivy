export type { Span, SpanEvent, Trace } from "../spans/types.ts";
import type { FailureKind } from "@ivy/spans";

export interface AuthSettings {
  enabled: true;
  issuer: string;
  clientId: string;
  audience: string;
  scopes: string;
}

export interface Config {
  version: string;
  auth: AuthSettings | { enabled: false };
  workspaces?: { multi: boolean };
  email?: { enabled: boolean };
  aws?: { quick_create: boolean };
  /** Which alert channels this server has configured (env vars); each is hidden or disabled otherwise. */
  alerts?: { slack: boolean; email: boolean };
  /** Billing service (`IVY_BILLING_URL`); no billing buttons without it. */
  billing?: { url: string };
}

export interface WorkspaceLimits {
  plan: string;
  monthly_trace_quota: number | null;
  over_quota: "block" | "allow";
  source: "workspace" | "unset";
}

/** `GET /api/w/:workspace/usage`: this month's traces of all the workspace's projects. */
export interface Usage {
  workspace: string;
  month: string;
  period: { start: string; end: string };
  traces: number;
  limits: WorkspaceLimits;
  blocked: boolean;
}

export type Role = "owner" | "member";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  role: Role;
  default: boolean;
  /** The default project: keys without a project and functions traced without one go there. */
  default_project_id: string;
  created_at: string;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  archived: boolean;
  default: boolean;
  created_at: string;
}

export interface Member {
  sub: string;
  email: string | null;
  role: Role;
  you: boolean;
  joined_at: string;
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

export interface CreatedInvitation {
  invitation: Invitation;
  url: string;
  email_sent: boolean;
  email_error: string | null;
}

export interface InvitationInfo {
  workspace: { slug: string; name: string };
  email: string;
  role: Role;
  status: InvitationStatus;
  invited_by: string | null;
  expires_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  kind: "user" | "auto-trace" | "bootstrap";
  prefix: string;
  created_at: string;
  revoked_at: string | null;
}

export interface CreatedKey extends ApiKey {
  key: string;
  endpoint: string | null;
}

/** Set on rows of workspace-wide queries (all projects). */
export interface ProjectRef {
  project_id?: string;
  project?: string | null;
}

export interface FunctionSummary extends ProjectRef {
  name: string;
  region: string;
  invocations: number;
  errors: number;
  error_rate: number;
  cold_starts: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  /** null when the function was only throttled in the range. */
  last_invoked: string | null;
  /** Requests Lambda rejected (CloudWatch Throttles); they never reached the function. */
  throttles: number;
}

export interface Invocation extends ProjectRef {
  trace_id: string;
  span_id: string;
  ts: string;
  function: string;
  region: string;
  /** `in_progress`: still running, or past `deadline` with no completion recorded (`inProgressState`). */
  status: "ok" | "error" | "in_progress";
  duration_ms: number;
  cold_start: boolean;
  request_id: string;
  trigger: string;
  http_method: string | null;
  http_path: string | null;
  http_status: number | null;
  error_type: string | null;
  error_message: string | null;
  memory_used_mb: number | null;
  memory_limit_mb: number | null;
  failure_phase: "init" | "invoke" | null;
  failure_kind: FailureKind | null;
  synthetic: boolean;
  init_duration_ms: number | null;
  /** In-progress rows: the invocation's deadline and when the extension last reported it running. */
  deadline?: string | null;
  last_seen?: string | null;
}

export interface ErrorGroupMessage {
  message: string;
  count: number;
  sample_trace_id: string;
  last_seen: string;
}

export interface ErrorGroup extends ProjectRef {
  /** Also the invocations list's `group` filter. */
  fingerprint: string;
  function: string;
  error_type: string;
  /** The latest raw message. */
  error_message: string;
  /** The message with variable parts replaced by placeholders (`{path}`, `{id}`, …). */
  error_template: string;
  count: number;
  /** Distinct raw messages in the range. */
  variants: number;
  /** Up to five, most frequent first; empty for throttles. */
  top_messages: ErrorGroupMessage[];
  first_seen: string;
  last_seen: string;
  /** null for the synthetic Throttled group (no trace). */
  sample_trace_id: string | null;
  kind: "error" | "throttle";
  failure_kind: FailureKind | null;
}

export interface TimeseriesPoint {
  ts: string;
  invocations: number;
  errors: number;
  p95_ms: number;
  throttles: number;
}

export interface ListResponse<T> {
  items: T[];
}

export interface InvocationsResponse extends ListResponse<Invocation> {
  next_cursor: string | null;
}

export type Since = "15m" | "1h" | "24h" | "7d";

export type TimeRange = { since: Since } | { from: string; to: string };

export type TraceState = "traced" | "available" | "opted_out" | "unsupported" | "conflict" | "error" | "pending";

export type AwsAccountStatus = "pending" | "connected" | "error";

export interface AwsSetup {
  principal_arn: string | null;
  /** True when this server can produce one-click CloudFormation quick-create links. */
  quick_create: boolean;
  events_url: string | null;
  public_url: string | null;
  ingest_endpoint: string | null;
  layer_sha256: string | null;
  default_region: string;
  regions: string[];
  sync_interval_seconds: number;
  issues: string[];
}

export interface AwsAccount {
  id: string;
  name: string;
  account_id: string;
  role_arn: string;
  external_id: string;
  stack_name: string;
  stack_region: string;
  default_project_id: string | null;
  default_project: string | null;
  regions: string[];
  all_regions: boolean;
  status: AwsAccountStatus;
  error: string | null;
  created_at: string | null;
  verified_at: string | null;
  last_sync_at: string | null;
  reviewed_at: string | null;
  syncing: boolean;
  throttle_metrics: boolean;
  throttle_status: "ok" | "missing_permission" | "error" | null;
  counts: Record<TraceState | "total" | "new", number>;
  quick_create_url: string | null;
  /** Why there is no quick-create link although the server supports them. */
  quick_create_error: string | null;
  template_download_url: string;
}

export type ManualMode = "trace" | "exclude";

export interface AwsFunction {
  account_id: string;
  region: string;
  name: string;
  arn: string;
  runtime: string;
  stack: string | null;
  tags: Record<string, string>;
  last_modified: string | null;
  state: TraceState;
  reason: string | null;
  project_id: string | null;
  project: string | null;
  source: "tag" | "manual" | "rule" | null;
  rule_id: string | null;
  manual: { mode: ManualMode; project_id: string | null; project: string | null } | null;
  new: boolean;
  first_seen_at: string | null;
  updated_at: string;
}

export interface FunctionGroup {
  stack: string | null;
  region: string | null;
  counts: { total: number; traced: number; available: number; new: number };
  rule: { id: string; project_id: string; project: string | null; enabled: boolean } | null;
  suggested_project: string | null;
  functions: AwsFunction[];
}

export interface RuleMatcher {
  account_id?: string | null;
  region?: string | null;
  stack?: string | null;
  name?: string | null;
  tag?: string | null;
}

export interface Rule {
  id: string;
  position: number;
  matcher: Required<{ [K in keyof RuleMatcher]: string | null }>;
  project_id: string;
  project: string | null;
  enabled: boolean;
  created_at: string;
}

export type DryRunOutcome = "trace" | "unchanged" | "excluded" | "other" | "unsupported";

export interface DryRunResponse {
  count: number;
  summary: Record<DryRunOutcome, number>;
  items: { function: AwsFunction; outcome: DryRunOutcome; project: string | null }[];
}

export interface VerifyResponse {
  verified: boolean;
  account: AwsAccount;
}

export interface TracingResponse {
  applied: boolean;
  error: string | null;
  function: AwsFunction | null;
}

export interface AlertSettings {
  slack_enabled: boolean;
  interval_minutes: number;
  every_occurrences: number;
  include_throttles: boolean;
}

export interface SlackChannel {
  id: string;
  team_name: string;
  channel: string;
  status: "ok" | "broken";
  error: string | null;
  configuration_url: string | null;
  created_at: string;
}

export interface AlertsResponse {
  available: { slack: boolean; missing: string[] };
  can_edit: boolean;
  settings: AlertSettings;
  integrations: SlackChannel[];
}

export interface DigestInfo {
  available: boolean;
  missing: string[];
  schedule: string;
  enabled: boolean;
  can_edit: boolean;
  subscribed: boolean | null;
  recipients: number;
}

export interface DigestPreview {
  subject: string;
  html: string;
  text: string;
  period: { from: string; to: string };
  empty: boolean;
}

export interface NotificationItem {
  workspace: { id: string; slug: string; name: string };
  digest: boolean;
}

export interface NotificationsResponse {
  email: string | null;
  digest_available: boolean;
  items: NotificationItem[];
}
