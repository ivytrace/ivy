import type { FunctionSetting, ProjectRule, ProjectSource, RuleMatcher } from './types.js';

export const TRACE_TAG = 'ivy:trace';
export const PROJECT_TAG = 'ivy:project';
export const STACK_TAG = 'aws:cloudformation:stack-name';

/** What the assignment needs to know about a function. */
export interface FunctionFacts {
  account_id: string;
  region: string;
  name: string;
  tags: Record<string, string>;
}

export interface AssignmentContext {
  /** The manual choice for this function, if any. */
  manual: FunctionSetting | null;
  /** The workspace's rules in evaluation order. */
  rules: ProjectRule[];
  /** Active (not archived) projects by ID and by slug. */
  projectsById: Map<string, { id: string; slug: string }>;
  projectsBySlug: Map<string, { id: string; slug: string }>;
  /** The workspace's default project. */
  defaultProjectId: string;
}

export type Assignment =
  | { traced: true; projectId: string; source: Exclude<ProjectSource, ''>; ruleId: string; reason: string }
  | { traced: false; state: 'opted_out' | 'available'; source: ProjectSource; ruleId: ''; reason: string };

const globCache = new Map<string, RegExp>();

/** `*` matches any run of characters, `?` one character; everything else is literal. */
export function globMatch(pattern: string, value: string): boolean {
  let re = globCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');
    globCache.set(pattern, re);
  }
  return re.test(value);
}

export const stackOf = (tags: Record<string, string>) => tags[STACK_TAG] ?? '';

/** True when every non-empty field of the matcher matches the function. An empty matcher matches nothing. */
export function matchesRule(m: Partial<RuleMatcher>, fn: FunctionFacts): boolean {
  if (!m.account_id && !m.region && !m.stack && !m.name && !m.tag) return false;
  if (m.account_id && m.account_id !== fn.account_id) return false;
  if (m.region && m.region !== fn.region) return false;
  if (m.stack && !globMatch(m.stack, stackOf(fn.tags))) return false;
  if (m.name && !globMatch(m.name, fn.name)) return false;
  if (m.tag) {
    const eq = m.tag.indexOf('=');
    const key = eq < 0 ? m.tag : m.tag.slice(0, eq);
    const value = fn.tags[key];
    if (value === undefined) return false;
    if (eq >= 0 && !globMatch(m.tag.slice(eq + 1), value)) return false;
  }
  return true;
}

/**
 * Decides whether a function is traced and into which project. Precedence:
 * 1. tags: `ivy:trace=false` never traces; `ivy:trace=true` traces;
 * 2. the manual choice in the dashboard (trace into a project, or exclude);
 * 3. the workspace's enabled rules, in order, first match wins;
 * 4. otherwise not traced ("available").
 * Whenever a function is traced, an `ivy:project=<slug>` tag naming an active project picks the
 * project; otherwise the manual choice's, the rule's, or the workspace default project.
 */
export function assignProject(fn: FunctionFacts, ctx: AssignmentContext): Assignment {
  const tagTrace = fn.tags[TRACE_TAG]?.trim().toLowerCase();
  if (tagTrace === 'false') return { traced: false, state: 'opted_out', source: 'tag', ruleId: '', reason: `Tagged ${TRACE_TAG}=false` };

  const tagProject = fn.tags[PROJECT_TAG] ? ctx.projectsBySlug.get(fn.tags[PROJECT_TAG].trim()) : undefined;
  const active = (id: string | undefined) => (id && ctx.projectsById.has(id) ? id : undefined);
  const rule = ctx.rules.find((r) => r.enabled && active(r.project_id) && matchesRule(r, fn));
  const manual = ctx.manual?.mode ? ctx.manual : null;
  const manualProject = manual?.mode === 'trace' ? active(manual.project_id) : undefined;

  if (tagTrace === 'true') {
    const projectId = tagProject?.id ?? manualProject ?? rule?.project_id ?? ctx.defaultProjectId;
    return { traced: true, projectId, source: 'tag', ruleId: '', reason: `Tagged ${TRACE_TAG}=true` };
  }
  if (manual?.mode === 'exclude') return { traced: false, state: 'opted_out', source: 'manual', ruleId: '', reason: 'Excluded in the dashboard' };
  if (manual?.mode === 'trace') {
    return { traced: true, projectId: tagProject?.id ?? manualProject ?? ctx.defaultProjectId, source: 'manual', ruleId: '', reason: 'Selected in the dashboard' };
  }
  if (rule) return { traced: true, projectId: tagProject?.id ?? rule.project_id, source: 'rule', ruleId: rule.id, reason: 'Matches a rule' };
  return { traced: false, state: 'available', source: '', ruleId: '', reason: 'Not selected for tracing' };
}

export function assignmentContext(
  projects: { id: string; slug: string; archived: boolean }[],
  rules: ProjectRule[],
  defaultProjectId: string,
): Omit<AssignmentContext, 'manual'> {
  const activeProjects = projects.filter((p) => !p.archived);
  return {
    rules: [...rules].sort((a, b) => a.position - b.position || a.created_at - b.created_at),
    projectsById: new Map(activeProjects.map((p) => [p.id, p])),
    projectsBySlug: new Map(activeProjects.map((p) => [p.slug, p])),
    defaultProjectId,
  };
}
