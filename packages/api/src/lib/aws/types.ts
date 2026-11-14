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
  regions: string[];
  all_regions: boolean;
  status: AccountStatus;
  error: string;
  created_at: number;
  verified_at: number;
  last_sync_at: number;
}

export type TraceState = 'traced' | 'opted_out' | 'unsupported' | 'conflict' | 'error' | 'pending';

export const TRACE_STATES: TraceState[] = ['traced', 'opted_out', 'unsupported', 'conflict', 'error', 'pending'];

export interface FunctionStatus {
  tenant_id: string;
  account_id: string;
  region: string;
  function_name: string;
  function_arn: string;
  runtime: string;
  state: TraceState;
  reason: string;
  updated_at: number;
}

export interface FunctionSetting {
  account_id: string;
  region: string;
  function_name: string;
  tracing_enabled: boolean;
}
