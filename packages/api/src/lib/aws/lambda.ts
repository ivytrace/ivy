import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  GetFunctionConfigurationCommand,
  ListFunctionsCommand,
  ListLayerVersionsCommand,
  PublishLayerVersionCommand,
  UpdateFunctionConfigurationCommand,
  type FunctionConfiguration,
  type LambdaClient,
  type Runtime,
} from '@aws-sdk/client-lambda';
import { GetResourcesCommand, type ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { fromConfiguration, type FunctionUpdate, type LambdaFunction } from './attach.js';
import { LAYER_NAME, layerZipPath } from './config.js';

const COMPATIBLE_RUNTIMES: Runtime[] = ['nodejs18.x', 'nodejs20.x', 'nodejs22.x', 'nodejs24.x'];

export async function listFunctions(lambda: LambdaClient): Promise<FunctionConfiguration[]> {
  const out: FunctionConfiguration[] = [];
  let Marker: string | undefined;
  do {
    const page = await lambda.send(new ListFunctionsCommand({ Marker, MaxItems: 50 }));
    out.push(...(page.Functions ?? []));
    Marker = page.NextMarker;
  } while (Marker);
  return out;
}

/** Tags of every function in the region in a few calls, instead of one ListTags per function. */
export async function listFunctionTags(
  tagging: ResourceGroupsTaggingAPIClient,
  arns?: string[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  let PaginationToken: string | undefined;
  do {
    const page = await tagging.send(
      new GetResourcesCommand(
        arns ? { ResourceARNList: arns, PaginationToken } : { ResourceTypeFilters: ['lambda:function'], PaginationToken },
      ),
    );
    for (const r of page.ResourceTagMappingList ?? []) {
      if (!r.ResourceARN) continue;
      out.set(r.ResourceARN, Object.fromEntries((r.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? ''])));
    }
    PaginationToken = page.PaginationToken || undefined;
  } while (PaginationToken);
  return out;
}

export async function getFunction(lambda: LambdaClient, tagging: ResourceGroupsTaggingAPIClient, name: string) {
  const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
  const tags = config.FunctionArn ? await listFunctionTags(tagging, [config.FunctionArn]).catch(() => new Map()) : new Map();
  return fromConfiguration(config, tags.get(config.FunctionArn ?? '') ?? {});
}

export interface LayerZip {
  bytes: Uint8Array;
  sha256: string;
}

let zip: LayerZip | null | undefined;

export function layerZip(): LayerZip | null {
  if (zip !== undefined) return zip;
  const file = layerZipPath();
  if (!file) return (zip = null);
  const bytes = readFileSync(file);
  return (zip = { bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
}

export function setLayerZipForTests(value: LayerZip | null | undefined) {
  zip = value;
}

const layerCache = new Map<string, Promise<string>>();

/**
 * Returns the ARN of a layer version in this account/region whose content matches the zip that
 * ships with this Ivy build, publishing one if needed. The zip's hash is kept in the description.
 */
export function ensureLayer(lambda: LambdaClient, accountId: string, region: string, layer: LayerZip): Promise<string> {
  const key = `${accountId}/${region}/${layer.sha256}`;
  let pending = layerCache.get(key);
  if (!pending) {
    pending = findOrPublishLayer(lambda, layer);
    pending.catch(() => layerCache.delete(key));
    layerCache.set(key, pending);
  }
  return pending;
}

async function findOrPublishLayer(lambda: LambdaClient, layer: LayerZip): Promise<string> {
  const marker = `sha256:${layer.sha256}`;
  let Marker: string | undefined;
  do {
    const page = await lambda.send(new ListLayerVersionsCommand({ LayerName: LAYER_NAME, Marker, MaxItems: 50 }));
    const match = page.LayerVersions?.find((v) => v.Description?.includes(marker));
    if (match?.LayerVersionArn) return match.LayerVersionArn;
    Marker = page.NextMarker;
  } while (Marker);

  const published = await lambda.send(
    new PublishLayerVersionCommand({
      LayerName: LAYER_NAME,
      Description: `Ivy Node.js layer ${marker}`,
      Content: { ZipFile: layer.bytes },
      CompatibleRuntimes: COMPATIBLE_RUNTIMES,
      CompatibleArchitectures: ['x86_64', 'arm64'],
    }),
  );
  if (!published.LayerVersionArn) throw new Error('PublishLayerVersion returned no ARN');
  return published.LayerVersionArn;
}

export function resetLayerCacheForTests() {
  layerCache.clear();
}

export const sleep = { wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

const CONFLICT_DELAYS_MS = [2000, 4000, 8000, 16000];

/**
 * UpdateFunctionConfiguration with the RevisionId we planned against, so concurrent syncs (or a
 * user deploying at the same moment) can't overwrite each other. Retries while another update is
 * in progress (ResourceConflictException).
 */
export async function applyUpdate(lambda: LambdaClient, fn: LambdaFunction, update: FunctionUpdate): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await lambda.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: fn.arn || fn.name,
          Layers: update.layers,
          Environment: { Variables: update.env },
          RevisionId: fn.revisionId || undefined,
        }),
      );
      return;
    } catch (err) {
      const name = (err as Error).name;
      if (name !== 'ResourceConflictException' || attempt >= CONFLICT_DELAYS_MS.length) throw err;
      await sleep.wait(CONFLICT_DELAYS_MS[attempt]);
    }
  }
}
