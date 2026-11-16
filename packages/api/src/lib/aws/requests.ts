import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { badRequest } from '../utils/http-error.js';
import { membershipOf, tenantOf } from '../tenancy/context.js';
import { listProjects } from '../tenancy/projects.js';
import { quickCreate } from './publish.js';
import { countFunctions, presentAccount, presentFunction, type Slugs } from './present.js';
import { isRegion } from './regions.js';
import { awsStore } from './store.js';
import { settingKey, syncFunction, type SyncFunctionOptions } from './sync.js';
import type { AwsAccount, FunctionSetting } from './types.js';

/** `/api/w/<workspace slug>`: where this workspace's routes live (for links in responses). */
export const workspaceBasePath = (c: Context) => `/api/w/${membershipOf(c).workspace.slug}`;

export async function projectSlugs(tenantId: string): Promise<Slugs> {
  return new Map((await listProjects(tenantId)).map((p) => [p.id, p.slug]));
}

/** Presents accounts with their function counts (one read of the workspace's functions). */
export async function presentAccounts(c: Context, accounts: AwsAccount[]) {
  const tenant = tenantOf(c).id;
  const workspace = membershipOf(c).workspace;
  const [functions, slugs, links] = await Promise.all([
    awsStore().listFunctions(tenant),
    projectSlugs(tenant),
    Promise.all(accounts.map((a) => quickCreate(a, workspace))),
  ]);
  const counts = countFunctions(functions, accounts);
  return accounts.map((a, i) => presentAccount(a, links[i], workspaceBasePath(c), slugs, counts.get(a.account_id)));
}

export async function loadAccount(c: Context): Promise<AwsAccount> {
  const account = await awsStore().getAccount(tenantOf(c).id, c.req.param('id') ?? '');
  if (!account) throw new HTTPException(404, { message: 'Account not found' });
  return account;
}

/** The workspace's connection to an AWS account, by 12-digit account ID; 404 when there is none. */
export async function connectedAccount(tenant: string, accountId: string): Promise<AwsAccount> {
  const account = (await awsStore().listAccounts(tenant)).find((a) => a.account_id === accountId);
  if (!account) throw new HTTPException(404, { message: `AWS account ${accountId} is not connected to this workspace` });
  return account;
}

export async function currentSetting(tenant: string, accountId: string, region: string, name: string): Promise<FunctionSetting | undefined> {
  return (await awsStore().listSettings(tenant, accountId)).find((s) => s.region === region && s.function_name === name);
}

/** Stores a function's setting first (so the next sync converges even if applying fails now), then applies it. */
export async function saveAndApply(tenant: string, account: AwsAccount, setting: FunctionSetting, options: SyncFunctionOptions = {}) {
  await awsStore().saveSetting(tenant, setting);
  if (account.status === 'pending') return { applied: false, error: 'Account not verified yet', function: null };
  try {
    const row = await syncFunction(account, setting.region, setting.function_name, options);
    const settings = new Map([[settingKey(setting.account_id, setting.region, setting.function_name), setting]]);
    const fn = presentFunction(row, settings, await projectSlugs(tenant), account.reviewed_at);
    return { applied: row.state !== 'error', error: row.state === 'error' ? row.reason : null, function: fn };
  } catch (err) {
    return { applied: false, error: (err as Error).message, function: null };
  }
}

export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a JSON object');
  return body as Record<string, unknown>;
}

export function parseRegions(value: unknown, field = 'regions'): string[] {
  if (!Array.isArray(value) || !value.every((r) => typeof r === 'string' && isRegion(r))) {
    throw badRequest(`${field} must be an array of AWS region names`);
  }
  return [...new Set(value as string[])];
}
