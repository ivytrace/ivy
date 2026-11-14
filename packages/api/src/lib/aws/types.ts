export type AccountStatus = 'pending' | 'connected' | 'error';

export interface AwsAccount {
  tenant_id: string;
  id: string;
  name: string;
  account_id: string;
  role_arn: string;
  external_id: string;
  event_secret: string;
  stack_name: string;
  stack_region: string;
  /** The project the UI preselects when tracing functions of this account ('' = the workspace default). */
  default_project_id: string;
  /** Functions first seen after this count as "new" (the UI sets it when the list is viewed). */
  reviewed_at: number;
  regions: string[];
  all_regions: boolean;
  status: AccountStatus;
  error: string;
  created_at: number;
  verified_at: number;
  last_sync_at: number;
}

/**
 * `available`: supported but not selected for tracing (no tag, manual choice or rule). `opted_out`:
 * excluded by the `ivy:trace=false` tag or a manual exclude.
 */
export type TraceState = 'traced' | 'available' | 'opted_out' | 'unsupported' | 'conflict' | 'error' | 'pending';

export const TRACE_STATES: TraceState[] = ['traced', 'available', 'opted_out', 'unsupported', 'conflict', 'error', 'pending'];

/** Why a function is (or isn't) traced: a tag, a manual choice in the dashboard, a rule, or nothing. */
export type ProjectSource = 'tag' | 'manual' | 'rule' | '';

export interface FunctionStatus {
  tenant_id: string;
  account_id: string;
  region: string;
  function_name: string;
  function_arn: string;
  runtime: string;
  state: TraceState;
  reason: string;
  /** The project the function sends to (traced), else ''. */
  project_id: string;
  project_source: ProjectSource;
  rule_id: string;
  /** The `aws:cloudformation:stack-name` tag, '' when the function isn't part of a stack. */
  stack: string;
  tags: Record<string, string>;
  last_modified: string;
  first_seen_at: number;
  updated_at: number;
}

/** The manual per-function choice: follow the rules (''), trace into a project, or exclude. */
export type ManualMode = '' | 'trace' | 'exclude';

export interface FunctionSetting {
  account_id: string;
  region: string;
  function_name: string;
  mode: ManualMode;
  /** With mode `trace`: the project ('' = the workspace default). */
  project_id: string;
}

/** Every non-empty field must match (see matchesRule). */
export interface RuleMatcher {
  account_id: string;
  region: string;
  /** Glob on the CloudFormation stack name. */
  stack: string;
  /** Glob on the function name (`orders-*` is a prefix match). */
  name: string;
  /** `key=value` (value may be a glob) or `key` (present). */
  tag: string;
}

export interface ProjectRule extends RuleMatcher {
  tenant_id: string;
  id: string;
  position: number;
  project_id: string;
  enabled: boolean;
  created_at: number;
}
