import type { Context } from 'hono';
import { presentFunction, presentRule } from '../../../lib/aws/present.js';
import { loadAccount, projectSlugs } from '../../../lib/aws/requests.js';
import { awsStore } from '../../../lib/aws/store.js';
import { settingKey } from '../../../lib/aws/sync.js';
import type { FunctionSetting, FunctionStatus, ProjectRule } from '../../../lib/aws/types.js';
import { findProject } from '../../../lib/tenancy/projects.js';
import { slugify } from '../../../lib/tenancy/slugs.js';
import { tenantOf } from '../../../lib/tenancy/context.js';

async function functionView(tenant: string, accountId?: string) {
  const store = awsStore();
  const [functions, accounts, settings, slugs] = await Promise.all([
    store.listFunctions(tenant, accountId),
    store.listAccounts(tenant),
    store.listSettings(tenant, accountId),
    projectSlugs(tenant),
  ]);
  const bySetting = new Map<string, FunctionSetting>(settings.map((s) => [settingKey(s.account_id, s.region, s.function_name), s]));
  const reviewed = new Map(accounts.map((a) => [a.account_id, a.reviewed_at]));
  const present = (f: FunctionStatus) => presentFunction(f, bySetting, slugs, reviewed.get(f.account_id) ?? 0);
  return { functions, present, slugs };
}

/** Every known function of the workspace, flat; `account`, `project` and `state` filter. */
export async function getAwsFunctions(c: Context) {
  const tenant = tenantOf(c).id;
  const { account, project, state } = c.req.query();
  const { functions, present } = await functionView(tenant, account || undefined);
  const projectId = project ? ((await findProject(tenant, project))?.id ?? '-') : undefined;
  const items = functions.filter((f) => (!projectId || f.project_id === projectId) && (!state || f.state === state));
  return c.json({ items: items.map(present) });
}

/** True for a rule that selects exactly one stack (optionally within an account/region). */
const isStackRule = (r: ProjectRule, stack: string, accountId: string, region: string) =>
  r.stack === stack && !r.name && !r.tag && (!r.account_id || r.account_id === accountId) && (!r.region || r.region === region);

/** One account's functions grouped by CloudFormation stack (and region); stackless ones last. */
export async function getAwsAccountFunctions(c: Context) {
  const account = await loadAccount(c);
  const tenant = account.tenant_id;
  const [{ functions, present, slugs }, rules] = await Promise.all([functionView(tenant, account.account_id), awsStore().listRules(tenant)]);
  const groups = new Map<string, FunctionStatus[]>();
  for (const f of functions) {
    const key = f.stack ? `${f.stack}\u0000${f.region}` : '';
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  return c.json({
    groups: keys.map((key) => {
      const fns = groups.get(key)!.sort((a, b) => a.function_name.localeCompare(b.function_name));
      const presented = fns.map(present);
      const [stack, region] = key ? key.split('\u0000') : [null, null];
      const rule = stack ? rules.find((r) => isStackRule(r, stack, account.account_id, region!)) : undefined;
      return {
        stack,
        region,
        counts: {
          total: fns.length,
          traced: fns.filter((f) => f.state === 'traced').length,
          available: fns.filter((f) => f.state === 'available').length,
          new: presented.filter((f) => f.new).length,
        },
        rule: rule ? (({ id, project_id, project, enabled }) => ({ id, project_id, project, enabled }))(presentRule(rule, slugs)) : null,
        suggested_project: stack ? slugify(stack, 'project') : null,
        functions: presented,
      };
    }),
  });
}
