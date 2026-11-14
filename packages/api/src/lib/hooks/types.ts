/**
 * Hook names and payloads (docs/implementation/hooks.md is the normative description).
 *
 * - Notification hooks, `on-<noun>-<past-tense-verb>`: run asynchronously after the action has
 *   committed, at most once, result ignored. They never block or change the action.
 * - Provider hooks, `<verb>-<noun>`: called synchronously when Ivy needs something it can't do
 *   itself; they return a result. Each has a built-in fallback when absent or failing.
 */

export const HOOK_VERSION = 1;

export interface WorkspaceRef {
  id: string;
  slug: string;
  name: string;
}

export interface UserRef {
  /** The OIDC subject. */
  sub: string;
  email: string | null;
}

/** `publish-cfn-template`: make the connection's template fetchable by CloudFormation. */
export interface PublishCfnTemplateData {
  workspace: WorkspaceRef;
  connection: { id: string; account_id: string; stack_name: string; stack_region: string };
  /** The CloudFormation template (YAML) with this connection's values as defaults, including its event secret. */
  template: string;
}

export interface PublishCfnTemplateResult {
  /** An `https://` URL CloudFormation can fetch (in practice an S3 URL, e.g. pre-signed). */
  url: string;
  /** When `url` stops working (ISO 8601); Ivy re-publishes 5 minutes before. Default: cached for 10 minutes. */
  expires_at?: string;
}

/** `on-workspace-created`: a workspace was created (including a user's personal workspace). */
export interface WorkspaceCreatedData {
  workspace: WorkspaceRef;
  owner: UserRef;
}

/** `on-member-joined`: a user accepted an invitation and is now a member. */
export interface MemberJoinedData {
  workspace: WorkspaceRef;
  member: UserRef & { role: 'owner' | 'member' };
  invitation_id: string;
  invited_by: UserRef | null;
}

/** `on-aws-account-connected`: verifying an AWS connection succeeded for the first time. */
export interface AwsAccountConnectedData {
  workspace: WorkspaceRef;
  connection: { id: string; name: string; account_id: string; stack_region: string; regions: string[]; all_regions: boolean };
}

/**
 * `on-error-group-created`: the alert evaluator saw an error group for the first time (within about a
 * minute of its first occurrence). Never carries payloads or log lines.
 */
export interface ErrorGroupCreatedData {
  workspace: WorkspaceRef;
  project: { id: string; slug: string; name: string };
  group: {
    /** The error group's fingerprint (`throttled:<region>:<function>` for throttles). */
    fingerprint: string;
    kind: 'error' | 'throttle';
    function: string;
    error_type: string;
    /** At most 500 characters. */
    error_message: string;
    failure_kind: 'init_failed' | 'out_of_memory' | 'timed_out' | 'crashed' | null;
    first_seen: string;
    occurrences: number;
    sample_trace_id: string | null;
    /** The group's latest trace (or errors page) in the dashboard; null without IVY_PUBLIC_URL. */
    url: string | null;
  };
}

export interface ProviderHooks {
  'publish-cfn-template': { data: PublishCfnTemplateData; result: PublishCfnTemplateResult };
}

export interface NotificationHooks {
  'on-workspace-created': WorkspaceCreatedData;
  'on-member-joined': MemberJoinedData;
  'on-aws-account-connected': AwsAccountConnectedData;
  'on-error-group-created': ErrorGroupCreatedData;
}

export type ProviderHookName = keyof ProviderHooks;
export type NotificationHookName = keyof NotificationHooks;
export type HookName = ProviderHookName | NotificationHookName;

/** What a hook gets on stdin. */
export interface HookEnvelope<D = unknown> {
  version: typeof HOOK_VERSION;
  hook: HookName;
  /** `hk_…`, unique per run; also in Ivy's log lines for the run. */
  id: string;
  timestamp: string;
  /** IVY_PUBLIC_URL, or the host name. */
  instance: string;
  data: D;
}
