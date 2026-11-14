import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { listProjects } from '../tenancy/projects.js';
import { mapLimit } from '../utils/concurrency.js';
import { assignmentContext, assignProject, stackOf, type Assignment, type AssignmentContext } from './assign.js';
import { fromConfiguration, needsLayer, planFunction, type Desired, type LambdaFunction, type Plan } from './attach.js';
import { assumeRole, forgetCredentials, regionClients } from './clients.js';
import { ingestConfig, type IngestConfig } from './config.js';
import { applyUpdate, ensureLayer, getFunction, layerZip, listFunctionTags, listFunctions } from './lambda.js';
import { AWS_REGIONS, isRegionDisabledError } from './regions.js';
import { awsStore } from './store.js';
import { pollAccountThrottles, throttlePollDue, type ThrottlePollResult } from './throttles.js';
import type { AwsAccount, FunctionSetting, FunctionStatus } from './types.js';

const FUNCTION_CONCURRENCY = 4;
const REGION_CONCURRENCY = 4;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const settingKey = (accountId: string, region: string, name: string) => `${accountId}/${region}/${name}`;

export function accountRegions(account: AwsAccount): string[] {
  return account.all_regions ? AWS_REGIONS : account.regions;
}

/** Everything a sync needs to decide where each function of a workspace goes. */
export interface Assigner {
  assign(account: AwsAccount, region: string, fn: LambdaFunction): Assignment;
  ingest(projectId: string): Promise<IngestConfig | null>;
}

/** Loads the workspace's projects, rules and manual choices once per sync. */
export async function loadAssigner(tenantId: string, accountId?: string): Promise<Assigner> {
  const store = awsStore();
  const [projects, rules, settings] = await Promise.all([listProjects(tenantId), store.listRules(tenantId), store.listSettings(tenantId, accountId)]);
  const base = assignmentContext(projects, rules);
  const manual = new Map<string, FunctionSetting>(settings.map((s) => [settingKey(s.account_id, s.region, s.function_name), s]));
  const ingest = new Map<string, Promise<IngestConfig | null>>();
  return {
    assign: (account, region, fn) =>
      assignProject(
        { account_id: account.account_id, region, name: fn.name, tags: fn.tags },
        { ...base, manual: manual.get(settingKey(account.account_id, region, fn.name)) ?? null } satisfies AssignmentContext,
      ),
    ingest(projectId) {
      let pending = ingest.get(projectId);
      if (!pending) ingest.set(projectId, (pending = ingestConfig(tenantId, projectId)));
      return pending;
    },
  };
}

interface FunctionContext {
  lambda: LambdaClient;
  tagging: ResourceGroupsTaggingAPIClient;
  assignment: Assignment;
  desired: Desired;
  /** Set when the layer could not be made available in this region. */
  layerError?: string;
  /** False when tags couldn't be read: we then don't attach to new functions, since one may carry the opt-out tag. */
  tagsKnown: boolean;
}

async function desiredFor(assigner: Assigner, assignment: Assignment): Promise<Desired> {
  if (!assignment.traced) return { enabled: false, offState: assignment.state, offReason: assignment.reason, layerArn: null, ingest: null };
  return { enabled: true, layerArn: null, ingest: await assigner.ingest(assignment.projectId) };
}

/** Plans and applies one function, returning the status row to store. */
export async function processFunction(account: AwsAccount, region: string, fn: LambdaFunction, ctx: FunctionContext): Promise<FunctionStatus> {
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
    reason: plan.reason || (plan.state === 'traced' ? '' : ctx.assignment.reason),
    project_id: ctx.assignment.traced ? ctx.assignment.projectId : '',
    project_source: ctx.assignment.source,
    rule_id: ctx.assignment.ruleId,
    stack: stackOf(fn.tags),
    tags: fn.tags,
    last_modified: fn.lastModified,
    first_seen_at: Date.now(),
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

async function syncRegion(account: AwsAccount, region: string, assigner: Assigner): Promise<void> {
  const { lambda, tagging } = await regionClients(account, region);
  const configs = await listFunctions(lambda);
  let tagsKnown = true;
  const tags = await listFunctionTags(tagging).catch(() => {
    tagsKnown = false;
    return new Map<string, Record<string, string>>();
  });
  const fns = configs.map((c) => fromConfiguration(c, tags.get(c.FunctionArn ?? '') ?? {}));
  const planned = await Promise.all(
    fns.map(async (fn) => {
      const assignment = assigner.assign(account, region, fn);
      return { fn, assignment, desired: await desiredFor(assigner, assignment) };
    }),
  );
  const layer = planned.some((p) => p.desired.ingest && needsLayer(p.fn, true)) ? await layerFor(lambda, account, region) : { arn: null };

  const rows = await mapLimit(planned, FUNCTION_CONCURRENCY, ({ fn, assignment, desired }) =>
    processFunction(account, region, fn, {
      lambda,
      tagging,
      assignment,
      desired: { ...desired, layerArn: layer.arn },
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
 * Lists the functions in each region, decides per function whether it is traced and into which
 * project (assign.ts), attaches, updates or detaches the layer where needed, and stores the
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

  const assigner = await loadAssigner(account.tenant_id, account.account_id);
  const errors: string[] = [];
  await mapLimit(regions, REGION_CONCURRENCY, async (region) => {
    try {
      await syncRegion(account, region, assigner);
    } catch (err) {
      if (account.all_regions && isRegionDisabledError(err)) return;
      errors.push(`${region}: ${message(err)}`);
    }
  });

  let throttles: ThrottlePollResult | null = null;
  if (throttlePollDue(account)) {
    try {
      throttles = await pollAccountThrottles(account, accountRegions(account), await store.listFunctions(account.tenant_id, account.account_id));
    } catch (err) {
      throttles = { throttle_status: 'error', throttles_polled_to: account.throttles_polled_to || 0, error: message(err) };
    }
    if (throttles.error) console.warn(`aws throttles ${account.tenant_id}/${account.id}: ${throttles.error}`);
  }

  const latest = await store.getAccount(account.tenant_id, account.id);
  if (!latest) return;
  await store.saveAccount({
    ...latest,
    ...(throttles && { throttle_status: throttles.throttle_status, throttles_polled_to: throttles.throttles_polled_to }),
    status: 'connected',
    error: errors.sort().join('\n'),
    last_sync_at: Date.now(),
  });
}

/** Applies the current assignment to a single function right away (after a manual choice in the dashboard). */
export async function syncFunction(account: AwsAccount, region: string, name: string): Promise<FunctionStatus> {
  const { lambda, tagging } = await regionClients(account, region);
  const fn = await getFunction(lambda, tagging, name);
  const assigner = await loadAssigner(account.tenant_id, account.account_id);
  const assignment = assigner.assign(account, region, fn);
  const desired = await desiredFor(assigner, assignment);
  const layer = desired.ingest && needsLayer(fn, true) ? await layerFor(lambda, account, region) : { arn: null };
  const row = await processFunction(account, region, fn, {
    lambda,
    tagging,
    assignment,
    desired: { ...desired, layerArn: layer.arn },
    layerError: layer.error,
    tagsKnown: true,
  });
  await awsStore().saveFunction(row);
  return row;
}

/** Removes the layer from every function Ivy traces in the account (used when disconnecting). */
export async function detachAccount(account: AwsAccount): Promise<string[]> {
  const errors: string[] = [];
  const off: Assignment = { traced: false, state: 'available', source: '', ruleId: '', reason: 'Account disconnected' };
  await mapLimit(accountRegions(account), REGION_CONCURRENCY, async (region) => {
    try {
      const { lambda, tagging } = await regionClients(account, region);
      const fns = (await listFunctions(lambda)).map((c) => fromConfiguration(c));
      await mapLimit(fns, FUNCTION_CONCURRENCY, async (fn) => {
        const row = await processFunction(account, region, fn, {
          lambda,
          tagging,
          assignment: off,
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
