import { cfnTemplateUrl, eventsUrl } from './config.js';
import { isSyncing } from './scheduler.js';
import { quickCreateUrl } from './template.js';
import { TRACE_STATES, type AwsAccount, type FunctionSetting, type FunctionStatus, type TraceState } from './types.js';
import { settingKey } from './sync.js';

const isoOrNull = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : null);

export const roleNameOf = (account: Pick<AwsAccount, 'role_arn'>) => account.role_arn.split('/').pop() ?? '';

export function presentAccount(account: AwsAccount, principal: string | null, counts: Partial<Record<TraceState, number>> = {}) {
  const templateUrl = cfnTemplateUrl();
  const allCounts = Object.fromEntries(TRACE_STATES.map((s) => [s, counts[s] ?? 0])) as Record<TraceState, number>;
  return {
    id: account.id,
    name: account.name,
    account_id: account.account_id,
    role_arn: account.role_arn,
    external_id: account.external_id,
    stack_name: account.stack_name,
    stack_region: account.stack_region,
    regions: account.regions,
    all_regions: account.all_regions,
    status: account.status,
    error: account.error || null,
    created_at: isoOrNull(account.created_at),
    verified_at: isoOrNull(account.verified_at),
    last_sync_at: isoOrNull(account.last_sync_at),
    syncing: isSyncing(account),
    counts: { ...allCounts, total: Object.values(allCounts).reduce((a, b) => a + b, 0) },
    quick_create_url: templateUrl
      ? quickCreateUrl({
          templateUrl,
          region: account.stack_region,
          stackName: account.stack_name,
          principalArn: principal,
          externalId: account.external_id,
          roleName: roleNameOf(account),
          eventsUrl: eventsUrl(),
          eventSecret: account.event_secret,
        })
      : null,
    template_download_url: `/api/aws/template.yaml?account=${encodeURIComponent(account.id)}&download=1`,
  };
}

export function presentFunction(fn: FunctionStatus, settings: Map<string, FunctionSetting>) {
  const setting = settings.get(`${fn.account_id}/${settingKey(fn.region, fn.function_name)}`);
  return {
    account_id: fn.account_id,
    region: fn.region,
    name: fn.function_name,
    arn: fn.function_arn,
    runtime: fn.runtime,
    state: fn.state,
    reason: fn.reason || null,
    tracing_enabled: setting ? setting.tracing_enabled : true,
    updated_at: new Date(fn.updated_at).toISOString(),
  };
}
