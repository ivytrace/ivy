import type { QuickCreate } from './publish.js';
import { isSyncing } from './scheduler.js';
import { settingKey } from './sync.js';
import { tracerName } from './tracers.js';
import { TRACE_STATES, type AwsAccount, type FunctionSetting, type FunctionStatus, type ProjectRule, type TraceState } from './types.js';

const isoOrNull = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : null);

export const roleNameOf = (account: Pick<AwsAccount, 'role_arn'>) => account.role_arn.split('/').pop() ?? '';

/** Project ID → slug for the workspace (archived included), to show slugs next to IDs. */
export type Slugs = Map<string, string>;

export interface AccountCounts {
  states: Partial<Record<TraceState, number>>;
  /** Available functions first seen after the account's `reviewed_at`. */
  newAvailable: number;
}

/** Per account: function counts by state, and new untraced ones. */
export function countFunctions(functions: FunctionStatus[], accounts: AwsAccount[]): Map<string, AccountCounts> {
  const reviewed = new Map(accounts.map((a) => [a.account_id, a.reviewed_at]));
  const out = new Map<string, AccountCounts>();
  for (const f of functions) {
    const c = out.get(f.account_id) ?? { states: {}, newAvailable: 0 };
    c.states[f.state] = (c.states[f.state] ?? 0) + 1;
    if (f.state === 'available' && f.first_seen_at > (reviewed.get(f.account_id) ?? 0)) c.newAvailable++;
    out.set(f.account_id, c);
  }
  return out;
}

export function presentAccount(account: AwsAccount, quick: QuickCreate, basePath: string, slugs: Slugs, counts?: AccountCounts) {
  const allCounts = Object.fromEntries(TRACE_STATES.map((s) => [s, counts?.states[s] ?? 0])) as Record<TraceState, number>;
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
    reviewed_at: isoOrNull(account.reviewed_at),
    syncing: isSyncing(account),
    throttle_metrics: account.throttle_metrics !== false,
    throttle_status: account.throttle_status || null,
    counts: { ...allCounts, total: Object.values(allCounts).reduce((a, b) => a + b, 0), new: counts?.newAvailable ?? 0 },
    quick_create_url: quick.url,
    quick_create_error: quick.error,
    template_download_url: `${basePath}/aws/template.yaml?account=${encodeURIComponent(account.id)}&download=1`,
  };
}

export function presentFunction(fn: FunctionStatus, settings: Map<string, FunctionSetting>, slugs: Slugs, reviewedAt = 0) {
  const setting = settings.get(settingKey(fn.account_id, fn.region, fn.function_name));
  const mode = setting?.mode ?? '';
  return {
    account_id: fn.account_id,
    region: fn.region,
    name: fn.function_name,
    arn: fn.function_arn,
    runtime: fn.runtime,
    stack: fn.stack || null,
    tags: fn.tags,
    last_modified: fn.last_modified || null,
    state: fn.state,
    reason: fn.reason || null,
    project_id: fn.project_id || null,
    project: fn.project_id ? (slugs.get(fn.project_id) ?? null) : null,
    source: fn.project_source || null,
    rule_id: fn.rule_id || null,
    manual: mode ? { mode, project_id: setting?.project_id || null, project: setting?.project_id ? (slugs.get(setting.project_id) ?? null) : null } : null,
    force: !!setting?.force,
    conflict: fn.state === 'conflict' ? fn.conflict || null : null,
    wrapper: fn.wrapper || null,
    tracer: fn.wrapper ? tracerName(fn.wrapper) : null,
    new: fn.state === 'available' && fn.first_seen_at > reviewedAt,
    first_seen_at: isoOrNull(fn.first_seen_at),
    updated_at: new Date(fn.updated_at).toISOString(),
  };
}

export function presentRule(rule: ProjectRule, slugs: Slugs) {
  return {
    id: rule.id,
    position: rule.position,
    matcher: {
      account_id: rule.account_id || null,
      region: rule.region || null,
      stack: rule.stack || null,
      name: rule.name || null,
      tag: rule.tag || null,
    },
    project_id: rule.project_id,
    project: slugs.get(rule.project_id) ?? null,
    enabled: rule.enabled,
    created_at: new Date(rule.created_at).toISOString(),
  };
}
