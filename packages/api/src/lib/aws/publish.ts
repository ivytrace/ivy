import { createHash } from 'node:crypto';
import { principalArn } from './clients.js';
import { eventsUrl } from './config.js';
import { callProvider, findHook } from '../hooks/run.js';
import type { TenantRecord } from '../tenancy/store.js';
import { roleNameOf } from './present.js';
import { quickCreateUrl, templateYaml } from './template.js';
import type { AwsAccount } from './types.js';

/** The connection's template with all its values (principal, external ID, role, events URL and secret) as defaults. */
export async function connectionTemplate(account: AwsAccount): Promise<string> {
  const events = eventsUrl();
  return templateYaml({
    principalArn: await principalArn(),
    externalId: account.external_id,
    roleName: roleNameOf(account),
    eventsUrl: events ?? '',
    eventSecret: events ? account.event_secret : '',
  });
}

export interface QuickCreate {
  /** A CloudFormation quick-create link without any secret in it, or null. */
  url: string | null;
  /** Why there is no link although the hook exists (shown in the UI next to the download fallback). */
  error: string | null;
}

/** Quick-create needs the `publish-cfn-template` hook; without it the UI offers the download only. */
export const quickCreateAvailable = async () => !!(await findHook('publish-cfn-template'));

const CACHE_FALLBACK_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;
const cache = new Map<string, { value: QuickCreate; expires: number }>();
const pending = new Map<string, Promise<QuickCreate>>();

/**
 * Publishes the connection's pre-filled template through the `publish-cfn-template` provider hook
 * (docs/implementation/hooks.md; result `{ url, expires_at? }`) and builds the quick-create
 * link from the returned URL. Cached per connection and template until shortly before `expires_at`
 * (10 minutes without one); failures are cached for 30 s.
 */
export async function quickCreate(account: AwsAccount, workspace: TenantRecord): Promise<QuickCreate> {
  if (!(await quickCreateAvailable())) return { url: null, error: null };
  const template = await connectionTemplate(account);
  const key = `${account.tenant_id}/${account.id}/${createHash('sha256').update(template).digest('hex')}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  let run = pending.get(key);
  if (!run) {
    run = publish(key, account, workspace, template).finally(() => pending.delete(key));
    pending.set(key, run);
  }
  return run;
}

const FALLBACK = 'Download the template and upload it in the CloudFormation console instead.';

async function publish(key: string, account: AwsAccount, workspace: TenantRecord, template: string): Promise<QuickCreate> {
  const res = await callProvider('publish-cfn-template', {
    workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
    connection: { id: account.id, account_id: account.account_id, stack_name: account.stack_name, stack_region: account.stack_region },
    template,
  });
  let value: QuickCreate = { url: null, error: null };
  let expires = Date.now() + FAILURE_TTL_MS;
  if (res.status === 'failed') value.error = `Publishing the template failed: ${res.error}. ${FALLBACK}`;
  if (res.status === 'ok') {
    const result = res.result as { url?: unknown; expires_at?: unknown };
    if (typeof result.url !== 'string' || !result.url.startsWith('https://')) {
      value.error = `The publish-cfn-template hook returned no https URL. ${FALLBACK}`;
    } else {
      value = { url: quickCreateUrl({ templateUrl: result.url, region: account.stack_region, stackName: account.stack_name }), error: null };
      const until = typeof result.expires_at === 'string' ? Date.parse(result.expires_at) : NaN;
      expires = Number.isFinite(until) ? until - EXPIRY_MARGIN_MS : Date.now() + CACHE_FALLBACK_MS;
    }
  }
  cache.set(key, { value, expires });
  return value;
}

export function clearQuickCreateCacheForTests() {
  cache.clear();
  pending.clear();
}
