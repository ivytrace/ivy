import { listProjects } from '../tenancy/projects.js';
import { assignmentContext, assignProject } from './assign.js';
import { awsStore } from './store.js';
import { settingKey } from './sync.js';
import type { FunctionSetting } from './types.js';

/**
 * Upgrade step for the removal of default projects: functions traced only because of
 * `ivy:trace=true` (no `ivy:project`, rule or manual choice) used to go to the workspace's default
 * project. Each gets a manual choice for the project it is traced into now, so it keeps sending
 * there instead of becoming `needs_project` and being detached. Idempotent (a function with the
 * choice resolves to a project); the API runs it on startup, before the sync loop.
 */
export async function keepTagTracedFunctions(): Promise<number> {
  const store = awsStore();
  const tenants = [...new Set((await store.listActiveAccounts()).map((a) => a.tenant_id))];
  let kept = 0;
  for (const tenant of tenants) {
    const [functions, settings, rules, projects] = await Promise.all([
      store.listFunctions(tenant),
      store.listSettings(tenant),
      store.listRules(tenant),
      listProjects(tenant),
    ]);
    const ctx = assignmentContext(projects, rules);
    const manual = new Map(settings.map((s) => [settingKey(s.account_id, s.region, s.function_name), s]));
    const choices: FunctionSetting[] = [];
    for (const fn of functions) {
      if (fn.state !== 'traced' || !ctx.projectsById.has(fn.project_id)) continue;
      const setting = manual.get(settingKey(fn.account_id, fn.region, fn.function_name)) ?? null;
      const next = assignProject({ account_id: fn.account_id, region: fn.region, name: fn.function_name, tags: fn.tags }, { ...ctx, manual: setting });
      if (next.traced || next.state !== 'needs_project') continue;
      choices.push({ account_id: fn.account_id, region: fn.region, function_name: fn.function_name, mode: 'trace', project_id: fn.project_id });
    }
    if (choices.length) await store.saveSettings(tenant, choices);
    kept += choices.length;
  }
  return kept;
}
