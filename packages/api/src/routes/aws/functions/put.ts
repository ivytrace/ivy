import type { Context } from 'hono';
import { isRegion } from '../../../lib/aws/regions.js';
import { connectedAccount, currentSetting, jsonBody, saveAndApply } from '../../../lib/aws/requests.js';
import { targetProject } from '../../../lib/aws/rules.js';
import { triggerSync } from '../../../lib/aws/scheduler.js';
import { awsStore } from '../../../lib/aws/store.js';
import { settingKey } from '../../../lib/aws/sync.js';
import type { ManualMode } from '../../../lib/aws/types.js';
import { tenantOf } from '../../../lib/tenancy/context.js';
import { badRequest } from '../../../lib/utils/http-error.js';

/** `mode` + `project` from a request body into a stored choice (`rules` clears it). */
async function parseChoice(tenant: string, body: Record<string, unknown>): Promise<{ mode: ManualMode; project_id: string }> {
  const mode = body.mode;
  if (mode !== 'trace' && mode !== 'exclude' && mode !== 'rules') throw badRequest('mode must be "trace", "exclude" or "rules"');
  if (mode !== 'trace') return { mode: mode === 'rules' ? '' : 'exclude', project_id: '' };
  return { mode, project_id: await targetProject(tenant, body.project) };
}

/** A new choice keeps a force install, except an exclude: that hands the other tracer's wrapper back for good. */
const keepForce = (mode: ManualMode, force: boolean | undefined) => mode !== 'exclude' && !!force;

/**
 * The manual choice for one function: trace into a project, exclude, or follow the rules again.
 * Stored first, so even if applying it fails now, the next sync converges.
 */
export async function putAwsFunction(c: Context) {
  const tenant = tenantOf(c).id;
  const { accountId, region, name } = c.req.param() as { accountId: string; region: string; name: string };
  if (!isRegion(region)) throw badRequest(`Invalid region: ${region}`);
  const choice = await parseChoice(tenant, await jsonBody(c));
  const account = await connectedAccount(tenant, accountId);
  const force = keepForce(choice.mode, (await currentSetting(tenant, accountId, region, name))?.force);
  return c.json(await saveAndApply(tenant, account, { account_id: accountId, region, function_name: name, ...choice, force }));
}

/** The same choice for many functions ("Trace selected"); applied by a sync of each affected account. */
export async function postAwsFunctionsBulk(c: Context) {
  const tenant = tenantOf(c).id;
  const body = await jsonBody(c);
  const choice = await parseChoice(tenant, body);
  const list = body.functions;
  if (!Array.isArray(list) || !list.length || list.length > 500) throw badRequest('functions must be an array of 1–500 { account_id, region, name }');
  const targets = list.map((f) => {
    const { account_id, region, name } = (f ?? {}) as Record<string, unknown>;
    if (typeof account_id !== 'string' || typeof region !== 'string' || !isRegion(region) || typeof name !== 'string' || !name) {
      throw badRequest('Each function needs account_id, region and name');
    }
    return { account_id, region, name };
  });
  const accounts = new Map<string, Awaited<ReturnType<typeof connectedAccount>>>();
  for (const t of targets) if (!accounts.has(t.account_id)) accounts.set(t.account_id, await connectedAccount(tenant, t.account_id));
  const existing = new Map((await awsStore().listSettings(tenant)).map((s) => [settingKey(s.account_id, s.region, s.function_name), s]));
  await awsStore().saveSettings(
    tenant,
    targets.map((t) => ({
      account_id: t.account_id,
      region: t.region,
      function_name: t.name,
      ...choice,
      force: keepForce(choice.mode, existing.get(settingKey(t.account_id, t.region, t.name))?.force),
    })),
  );
  for (const account of accounts.values()) if (account.status !== 'pending') void triggerSync(account);
  return c.json({ updated: targets.length }, 202);
}
