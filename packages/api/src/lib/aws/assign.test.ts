import { describe, expect, it } from 'vitest';
import { assignmentContext, assignProject, globMatch, matchesRule, type FunctionFacts } from './assign.js';
import type { FunctionSetting, ProjectRule, RuleMatcher } from './types.js';

const projects = [
  { id: 'prj_default', slug: 'default', archived: false },
  { id: 'prj_prod', slug: 'api-prod', archived: false },
  { id: 'prj_staging', slug: 'api-staging', archived: false },
  { id: 'prj_tagged', slug: 'tagged', archived: false },
  { id: 'prj_old', slug: 'old', archived: true },
];

const empty: RuleMatcher = { account_id: '', region: '', stack: '', name: '', tag: '' };
let n = 0;
const rule = (m: Partial<RuleMatcher>, project_id: string, extra: Partial<ProjectRule> = {}): ProjectRule => ({
  tenant_id: 't',
  id: `rul_${++n}`,
  position: n,
  ...empty,
  ...m,
  project_id,
  enabled: true,
  created_at: n,
  ...extra,
});

const fn = (name: string, tags: Record<string, string> = {}, region = 'eu-west-1', account_id = '111111111111'): FunctionFacts => ({ account_id, region, name, tags });
const stack = (s: string) => ({ 'aws:cloudformation:stack-name': s });
const manual = (mode: FunctionSetting['mode'], project_id = ''): FunctionSetting => ({ account_id: '111111111111', region: 'eu-west-1', function_name: 'x', mode, project_id });

function assign(f: FunctionFacts, rules: ProjectRule[], m: FunctionSetting | null = null) {
  return assignProject(f, { ...assignmentContext(projects, rules, 'prj_default'), manual: m });
}

describe('globMatch and matchesRule', () => {
  it('matches globs, prefixes and exact names', () => {
    expect(globMatch('orders-*', 'orders-create')).toBe(true);
    expect(globMatch('orders-*', 'xorders-create')).toBe(false);
    expect(globMatch('api-?-prod', 'api-1-prod')).toBe(true);
    expect(globMatch('a.b', 'axb')).toBe(false);
    expect(globMatch('exact', 'exact')).toBe(true);
  });

  it('needs every set field to match', () => {
    const f = fn('orders-create', { ...stack('api-prod'), team: 'core' });
    expect(matchesRule({ stack: 'api-prod' }, f)).toBe(true);
    expect(matchesRule({ stack: 'api-*', name: 'orders-*' }, f)).toBe(true);
    expect(matchesRule({ stack: 'api-prod', region: 'us-east-1' }, f)).toBe(false);
    expect(matchesRule({ account_id: '222222222222', name: '*' }, f)).toBe(false);
    expect(matchesRule({ tag: 'team=core' }, f)).toBe(true);
    expect(matchesRule({ tag: 'team=c*' }, f)).toBe(true);
    expect(matchesRule({ tag: 'team' }, f)).toBe(true);
    expect(matchesRule({ tag: 'team=infra' }, f)).toBe(false);
    expect(matchesRule({ tag: 'owner' }, f)).toBe(false);
    expect(matchesRule({}, f)).toBe(false);
    expect(matchesRule({ stack: 'api-prod' }, fn('loose'))).toBe(false);
  });
});

describe('assignProject precedence', () => {
  const rules = [rule({ stack: 'api-prod' }, 'prj_prod'), rule({ name: 'api-staging-*' }, 'prj_staging'), rule({ name: '*' }, 'prj_staging')];

  it('traces nothing without a tag, a manual choice or a rule', () => {
    expect(assign(fn('anything'), [])).toMatchObject({ traced: false, state: 'available', source: '' });
  });

  it('uses the first enabled rule that matches, skipping disabled rules and archived projects', () => {
    expect(assign(fn('a', stack('api-prod')), rules)).toMatchObject({ traced: true, projectId: 'prj_prod', source: 'rule', ruleId: rules[0].id });
    expect(assign(fn('api-staging-x'), rules)).toMatchObject({ projectId: 'prj_staging', ruleId: rules[1].id });
    const disabled = [rule({ stack: 'api-prod' }, 'prj_prod', { enabled: false }), rule({ name: '*' }, 'prj_staging')];
    expect(assign(fn('a', stack('api-prod')), disabled)).toMatchObject({ projectId: 'prj_staging' });
    const archived = [rule({ stack: 'api-prod' }, 'prj_old')];
    expect(assign(fn('a', stack('api-prod')), archived)).toMatchObject({ traced: false, state: 'available' });
  });

  it('lets a manual choice beat rules', () => {
    expect(assign(fn('a', stack('api-prod')), rules, manual('exclude'))).toMatchObject({ traced: false, state: 'opted_out', source: 'manual' });
    expect(assign(fn('a', stack('api-prod')), rules, manual('trace', 'prj_staging'))).toMatchObject({ traced: true, projectId: 'prj_staging', source: 'manual' });
    expect(assign(fn('loose'), [], manual('trace'))).toMatchObject({ traced: true, projectId: 'prj_default', source: 'manual' });
    expect(assign(fn('a', stack('api-prod')), rules, manual(''))).toMatchObject({ source: 'rule' });
  });

  it('lets tags beat everything', () => {
    const off = { 'ivy:trace': 'false', ...stack('api-prod') };
    expect(assign(fn('a', off), rules, manual('trace', 'prj_prod'))).toMatchObject({ traced: false, state: 'opted_out', source: 'tag' });
    expect(assign(fn('a', { 'ivy:trace': 'true' }), [], manual('exclude'))).toMatchObject({ traced: true, projectId: 'prj_default', source: 'tag' });
    expect(assign(fn('a', { 'ivy:trace': 'TRUE', 'ivy:project': 'tagged' }), rules)).toMatchObject({ projectId: 'prj_tagged', source: 'tag' });
    // ivy:project picks the project of a function traced by a rule or a manual choice too.
    expect(assign(fn('a', { 'ivy:project': 'tagged', ...stack('api-prod') }), rules)).toMatchObject({ projectId: 'prj_tagged', source: 'rule' });
    expect(assign(fn('a', { 'ivy:project': 'tagged' }), [], manual('trace', 'prj_prod'))).toMatchObject({ projectId: 'prj_tagged', source: 'manual' });
    // An unknown or archived slug is ignored; ivy:project alone doesn't trace.
    expect(assign(fn('a', { 'ivy:project': 'old', ...stack('api-prod') }), rules)).toMatchObject({ projectId: 'prj_prod' });
    expect(assign(fn('a', { 'ivy:project': 'tagged' }), [])).toMatchObject({ traced: false, state: 'available' });
  });
});
