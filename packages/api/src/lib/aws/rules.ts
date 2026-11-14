import { HTTPException } from 'hono/http-exception';
import { defaultProjectId, randomBase62 } from '../tenancy/ids.js';
import { findProject, listProjects } from '../tenancy/projects.js';
import { assignmentContext, assignProject, matchesRule } from './assign.js';
import { isRegion } from './regions.js';
import { triggerSync } from './scheduler.js';
import { awsStore } from './store.js';
import { settingKey } from './sync.js';
import type { FunctionStatus, ProjectRule, RuleMatcher } from './types.js';

const bad = (message: string) => new HTTPException(400, { message });

const str = (value: unknown, field: string, max = 200): string => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw bad(`matcher.${field} must be a string`);
  const v = value.trim();
  if (v.length > max) throw bad(`matcher.${field} is too long`);
  return v;
};

/** Validates a matcher from a request body. At least one field must be set. */
export function parseMatcher(input: unknown): RuleMatcher {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('matcher must be an object');
  const m = input as Record<string, unknown>;
  const matcher: RuleMatcher = {
    account_id: str(m.account_id, 'account_id').replace(/[\s-]/g, ''),
    region: str(m.region, 'region'),
    stack: str(m.stack, 'stack'),
    name: str(m.name, 'name'),
    tag: str(m.tag, 'tag'),
  };
  if (matcher.account_id && !/^\d{12}$/.test(matcher.account_id)) throw bad('matcher.account_id must be a 12-digit AWS account ID');
  if (matcher.region && !isRegion(matcher.region)) throw bad(`matcher.region: unknown region ${matcher.region}`);
  if (matcher.tag.startsWith('=')) throw bad('matcher.tag must be key or key=value');
  if (!matcher.account_id && !matcher.region && !matcher.stack && !matcher.name && !matcher.tag) {
    throw bad('matcher needs at least one of account_id, region, stack, name, tag (use name "*" for every function)');
  }
  return matcher;
}

/** A project of the workspace by slug or ID that can receive functions; 400 otherwise. */
export async function targetProject(tenantId: string, ref: unknown): Promise<string> {
  if (ref === undefined || ref === null || ref === '') return defaultProjectId(tenantId);
  const project = typeof ref === 'string' ? await findProject(tenantId, ref) : null;
  if (!project) throw bad(`Unknown project: ${String(ref)}`);
  if (project.archived) throw bad(`Project ${project.slug} is archived`);
  return project.id;
}

/** Re-syncs every connected account of the workspace so a rule change applies now, not at the next interval. */
export async function resyncWorkspace(tenantId: string): Promise<void> {
  for (const account of await awsStore().listAccounts(tenantId)) {
    if (account.status !== 'pending') void triggerSync(account);
  }
}

const newRuleId = () => `rul_${randomBase62(21)}`;

export async function createRule(tenantId: string, body: Record<string, unknown>): Promise<ProjectRule> {
  const matcher = parseMatcher(body.matcher);
  const project_id = await targetProject(tenantId, body.project);
  const rules = await awsStore().listRules(tenantId);
  const position = typeof body.position === 'number' ? Math.max(0, Math.floor(body.position)) : rules.length;
  const rule: ProjectRule = {
    tenant_id: tenantId,
    id: newRuleId(),
    ...matcher,
    project_id,
    enabled: body.enabled !== false,
    position,
    created_at: Date.now(),
  };
  // Insert at `position`, shifting the rest down, in one write.
  const ordered = [...rules];
  ordered.splice(Math.min(position, ordered.length), 0, rule);
  await awsStore().saveRules(tenantId, renumber(ordered));
  return { ...rule, position: ordered.indexOf(rule) };
}

const renumber = (rules: ProjectRule[]) => rules.map((r, i) => ({ ...r, position: i }));

async function loadRule(tenantId: string, id: string) {
  const rules = await awsStore().listRules(tenantId);
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new HTTPException(404, { message: 'Rule not found' });
  return { rule, rules };
}

export async function updateRule(tenantId: string, id: string, body: Record<string, unknown>): Promise<ProjectRule> {
  const { rule, rules } = await loadRule(tenantId, id);
  const next: ProjectRule = { ...rule };
  if (body.matcher !== undefined) Object.assign(next, parseMatcher(body.matcher));
  if (body.project !== undefined) next.project_id = await targetProject(tenantId, body.project);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw bad('enabled must be a boolean');
    next.enabled = body.enabled;
  }
  const ordered = rules.filter((r) => r.id !== id);
  const position = typeof body.position === 'number' ? Math.max(0, Math.floor(body.position)) : rules.indexOf(rule);
  ordered.splice(Math.min(position, ordered.length), 0, next);
  await awsStore().saveRules(tenantId, renumber(ordered));
  return { ...next, position: ordered.indexOf(next) };
}

export async function deleteRule(tenantId: string, id: string): Promise<void> {
  const { rules } = await loadRule(tenantId, id);
  await awsStore().saveRules(tenantId, renumber(rules.filter((r) => r.id !== id)), [id]);
}

/** Replaces the whole ordered list (used to reorder); rules not in `ids` are kept at the end. */
export async function reorderRules(tenantId: string, ids: unknown): Promise<ProjectRule[]> {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw bad('order must be an array of rule IDs');
  const rules = await awsStore().listRules(tenantId);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const ordered = [...new Set(ids as string[])].map((id) => byId.get(id)).filter((r): r is ProjectRule => !!r);
  for (const r of rules) if (!ordered.includes(r)) ordered.push(r);
  const next = renumber(ordered);
  await awsStore().saveRules(tenantId, next);
  return next;
}

export type DryRunOutcome = 'trace' | 'unchanged' | 'excluded' | 'other' | 'unsupported';

export interface DryRunItem {
  fn: FunctionStatus;
  /** What a new rule with this matcher (appended last) would do to the function. */
  outcome: DryRunOutcome;
  /** The project the function would send to after the change ('' when not traced). */
  project_id: string;
}

/**
 * Which known functions (as of each account's last sync) a matcher selects, and what adding it as
 * a rule would change, given tags, manual choices and the existing rules (which come first).
 */
export async function dryRun(tenantId: string, matcher: RuleMatcher, projectId: string): Promise<DryRunItem[]> {
  const store = awsStore();
  const [functions, rules, settings, projects] = await Promise.all([
    store.listFunctions(tenantId),
    store.listRules(tenantId),
    store.listSettings(tenantId),
    listProjects(tenantId),
  ]);
  const probe: ProjectRule = { tenant_id: tenantId, id: '__dry_run__', ...matcher, project_id: projectId, enabled: true, position: rules.length, created_at: Date.now() };
  const withTarget = projects.some((p) => p.id === projectId) ? projects : [...projects, { id: projectId, slug: projectId, archived: false }];
  const ctx = assignmentContext(withTarget, [...rules, probe], defaultProjectId(tenantId));
  const manual = new Map(settings.map((s) => [settingKey(s.account_id, s.region, s.function_name), s]));
  const out: DryRunItem[] = [];
  for (const fn of functions) {
    const facts = { account_id: fn.account_id, region: fn.region, name: fn.function_name, tags: fn.tags };
    if (!matchesRule(matcher, facts)) continue;
    const result = assignProject(facts, { ...ctx, manual: manual.get(settingKey(fn.account_id, fn.region, fn.function_name)) ?? null });
    const project = result.traced ? result.projectId : '';
    let outcome: DryRunOutcome;
    if (['unsupported', 'conflict', 'error'].includes(fn.state)) outcome = 'unsupported';
    else if (!result.traced) outcome = 'excluded';
    else if (result.ruleId !== probe.id) outcome = fn.state === 'traced' && fn.project_id === project ? 'unchanged' : 'other';
    else outcome = fn.state === 'traced' && fn.project_id === project ? 'unchanged' : 'trace';
    out.push({ fn, outcome, project_id: project });
  }
  return out;
}
