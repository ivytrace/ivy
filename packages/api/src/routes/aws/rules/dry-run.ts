import type { Context } from 'hono';
import { presentFunction } from '../../../lib/aws/present.js';
import { jsonBody, projectSlugs } from '../../../lib/aws/requests.js';
import { dryRun, parseMatcher, type DryRunOutcome } from '../../../lib/aws/rules.js';
import { awsStore } from '../../../lib/aws/store.js';
import { settingKey } from '../../../lib/aws/sync.js';
import { tenantOf } from '../../../lib/tenancy/context.js';
import { findProject } from '../../../lib/tenancy/projects.js';

/** The functions a matcher selects and what a rule with it would change. Stores nothing. */
export async function postRuleDryRun(c: Context) {
  const tenant = tenantOf(c).id;
  const body = await jsonBody(c);
  const matcher = parseMatcher(body.matcher);
  // An unknown project is fine here: the caller may be about to create it, or hasn't picked one yet.
  const known = typeof body.project === 'string' && body.project ? await findProject(tenant, body.project) : null;
  const projectId = known ? known.id : body.project ? '__new_project__' : '__no_project__';
  const [items, slugs, settings, accounts] = await Promise.all([
    dryRun(tenant, matcher, projectId),
    projectSlugs(tenant),
    awsStore().listSettings(tenant),
    awsStore().listAccounts(tenant),
  ]);
  if (!known && body.project) slugs.set('__new_project__', String(body.project));
  const bySetting = new Map(settings.map((s) => [settingKey(s.account_id, s.region, s.function_name), s]));
  const reviewed = new Map(accounts.map((a) => [a.account_id, a.reviewed_at]));
  const summary: Record<DryRunOutcome, number> = { trace: 0, unchanged: 0, excluded: 0, other: 0, unsupported: 0 };
  for (const i of items) summary[i.outcome]++;
  return c.json({
    count: items.length,
    summary,
    items: items.map((i) => ({
      function: presentFunction(i.fn, bySetting, slugs, reviewed.get(i.fn.account_id) ?? 0),
      outcome: i.outcome,
      project: i.project_id ? (slugs.get(i.project_id) ?? null) : null,
    })),
  });
}
