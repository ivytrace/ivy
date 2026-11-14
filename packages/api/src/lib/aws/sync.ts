import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { mapLimit } from '../utils/concurrency.js';
import { fromConfiguration, needsLayer, planFunction, type Desired, type LambdaFunction, type Plan } from './attach.js';
import { assumeRole, forgetCredentials, regionClients } from './clients.js';
import { ingestConfig } from './config.js';
import { applyUpdate, ensureLayer, getFunction, layerZip, listFunctionTags, listFunctions } from './lambda.js';
import { AWS_REGIONS, isRegionDisabledError } from './regions.js';
import { awsStore } from './store.js';
import type { AwsAccount, FunctionStatus } from './types.js';

const FUNCTION_CONCURRENCY = 4;
const REGION_CONCURRENCY = 4;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const settingKey = (region: string, name: string) => `${region}/${name}`;

export function accountRegions(account: AwsAccount): string[] {
  return account.all_regions ? AWS_REGIONS : account.regions;
}

interface FunctionContext {
  lambda: LambdaClient;
  tagging: ResourceGroupsTaggingAPIClient;
  desired: Desired;
  /** Set when the layer could not be made available in this region. */
  layerError?: string;
  /** False when tags couldn't be read: we then don't attach to new functions, since one may carry the opt-out tag. */
  tagsKnown: boolean;
}

/** Plans and applies one function, returning the status row to store. */
export async function processFunction(
  account: AwsAccount,
  region: string,
  fn: LambdaFunction,
  ctx: FunctionContext,
): Promise<FunctionStatus> {
  let plan = decide(fn, ctx);
  if (plan.update) {
    try {
      await applyUpdate(ctx.lambda, fn, plan.update);
    } catch (err) {
      if ((err as Error).name === 'PreconditionFailedException') {
        // The function changed between listing and updating: plan again against the new revision.
        try {
          const fresh = await getFunction(ctx.lambda, ctx.tagging, fn.arn || fn.name);
          plan = decide(fresh, ctx);
          if (plan.update) await applyUpdate(ctx.lambda, fresh, plan.update);
        } catch (retryErr) {
          plan = { state: 'error', reason: `Update failed: ${message(retryErr)}`, update: null };
        }
      } else {
        plan = { state: 'error', reason: `Update failed: ${message(err)}`, update: null };
      }
    }
  }
  return {
    tenant_id: account.tenant_id,
    account_id: account.account_id,
    region,
    function_name: fn.name,
    function_arn: fn.arn,
    runtime: fn.runtime || fn.packageType,
    state: plan.state,
    reason: plan.reason,
    updated_at: Date.now(),
  };
}

function decide(fn: LambdaFunction, ctx: FunctionContext): Plan {
  const plan = planFunction(fn, ctx.desired);
  if (plan.state === 'pending' && ctx.layerError) return { state: 'error', reason: ctx.layerError, update: null };
  if (!ctx.tagsKnown && plan.state === 'traced' && plan.update) return { state: 'pending', reason: "Couldn't read tags (tag:GetResources)", update: null };
  return plan;
}

async function layerFor(lambda: LambdaClient, account: AwsAccount, region: string): Promise<{ arn: string | null; error?: string }> {
  const zip = layerZip();
  if (!zip) return { arn: null, error: 'The layer zip is missing on the Ivy server (set IVY_LAYER_ZIP)' };
  try {
    return { arn: await ensureLayer(lambda, account.account_id, region, zip) };
  } catch (err) {
    return { arn: null, error: `Publishing the layer failed: ${message(err)}` };
  }
}

async function syncRegion(account: AwsAccount, region: string, disabled: Set<string>): Promise<void> {
  const { lambda, tagging } = await regionClients(account, region);
  const configs = await listFunctions(lambda);
  let tagsKnown = true;
  const tags = await listFunctionTags(tagging).catch(() => {
    tagsKnown = false;
    return new Map<string, Record<string, string>>();
  });
  const fns = configs.map((c) => fromConfiguration(c, tags.get(c.FunctionArn ?? '') ?? {}));
  const enabled = (fn: LambdaFunction) => !disabled.has(settingKey(region, fn.name));

  const ingest = await ingestConfig(account.tenant_id);
  const layer = ingest && fns.some((fn) => needsLayer(fn, enabled(fn))) ? await layerFor(lambda, account, region) : { arn: null };

  const rows = await mapLimit(fns, FUNCTION_CONCURRENCY, (fn) =>
    processFunction(account, region, fn, {
      lambda,
      tagging,
      desired: { enabled: enabled(fn), layerArn: layer.arn, ingest },
      layerError: layer.error,
      tagsKnown,
    }),
  );
  await awsStore().replaceRegionFunctions(account.tenant_id, account.account_id, region, rows);
}

export interface SyncOptions {
  /** Limit to these regions (e.g. from an EventBridge event); defaults to the account's regions. */
  regions?: string[];
}

/**
 * Lists the functions in each region, attaches or detaches the layer where needed and stores the
 * per-function state. Idempotent, and safe to run concurrently with itself (updates carry the
 * RevisionId they were planned against).
 */
export async function syncAccount(account: AwsAccount, options: SyncOptions = {}): Promise<void> {
  const store = awsStore();
  const regions = options.regions?.filter((r) => accountRegions(account).includes(r)) ?? accountRegions(account);

  try {
    await assumeRole(account);
  } catch (err) {
    forgetCredentials(account);
    const latest = (await store.getAccount(account.tenant_id, account.id)) ?? account;
    await store.saveAccount({ ...latest, status: 'error', error: `Can't assume ${account.role_arn}: ${message(err)}`, last_sync_at: Date.now() });
    return;
  }

  const settings = await store.listSettings(account.tenant_id, account.account_id);
  const disabled = new Set(settings.filter((s) => !s.tracing_enabled).map((s) => settingKey(s.region, s.function_name)));

  const errors: string[] = [];
  await mapLimit(regions, REGION_CONCURRENCY, async (region) => {
    try {
      await syncRegion(account, region, disabled);
    } catch (err) {
      if (account.all_regions && isRegionDisabledError(err)) return;
      errors.push(`${region}: ${message(err)}`);
    }
  });

  const latest = await store.getAccount(account.tenant_id, account.id);
  if (!latest) return;
  await store.saveAccount({ ...latest, status: 'connected', error: errors.sort().join('\n'), last_sync_at: Date.now() });
}

/** Applies the current tracing setting to a single function right away (after a dashboard toggle). */
export async function syncFunction(account: AwsAccount, region: string, name: string, enabled: boolean): Promise<FunctionStatus> {
  const { lambda, tagging } = await regionClients(account, region);
  const fn = await getFunction(lambda, tagging, name);
  const ingest = await ingestConfig(account.tenant_id);
  const layer = ingest && needsLayer(fn, enabled) ? await layerFor(lambda, account, region) : { arn: null };
  const row = await processFunction(account, region, fn, {
    lambda,
    tagging,
    desired: { enabled, layerArn: layer.arn, ingest },
    layerError: layer.error,
    tagsKnown: true,
  });
  await awsStore().saveFunction(row);
  return row;
}

/** Removes the layer from every function Ivy traces in the account (used when disconnecting). */
export async function detachAccount(account: AwsAccount): Promise<string[]> {
  const errors: string[] = [];
  await mapLimit(accountRegions(account), REGION_CONCURRENCY, async (region) => {
    try {
      const { lambda, tagging } = await regionClients(account, region);
      const fns = (await listFunctions(lambda)).map((c) => fromConfiguration(c));
      await mapLimit(fns, FUNCTION_CONCURRENCY, async (fn) => {
        const row = await processFunction(account, region, fn, {
          lambda,
          tagging,
          desired: { enabled: false, layerArn: null, ingest: null },
          tagsKnown: true,
        });
        if (row.state === 'error') errors.push(`${region}/${fn.name}: ${row.reason}`);
      });
    } catch (err) {
      if (!(account.all_regions && isRegionDisabledError(err))) errors.push(`${region}: ${message(err)}`);
    }
  });
  return errors;
}
