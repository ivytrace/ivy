import type { FunctionConfiguration } from '@aws-sdk/client-lambda';
import { EXEC_WRAPPER, LAYER_NAME, type IngestConfig } from './config.js';
import type { TraceState } from './types.js';

export const MAX_LAYERS = 5;
export const MIN_NODE_MAJOR = 18;
export const OPT_OUT_TAG = 'ivy:trace';
export const COMPONENT_TAG = 'ivy:component';
const IVY_ENV = ['IVY_ENDPOINT', 'IVY_API_KEY'] as const;

export interface LambdaFunction {
  name: string;
  arn: string;
  runtime: string;
  packageType: string;
  layers: string[];
  /** null when Lambda could not return the variables (e.g. a KMS key Ivy can't use). */
  env: Record<string, string> | null;
  envError: string;
  revisionId: string;
  lastModified: string;
  tags: Record<string, string>;
}

export interface Desired {
  /** Whether the function should be traced (see assign.ts). */
  enabled: boolean;
  /** State and reason to report when not traced (default: opted out). */
  offState?: 'available' | 'opted_out' | 'needs_project';
  offReason?: string;
  layerArn: string | null;
  ingest: IngestConfig | null;
}

export interface FunctionUpdate {
  layers: string[];
  env: Record<string, string>;
}

export interface Plan {
  state: TraceState;
  reason: string;
  update: FunctionUpdate | null;
}

export function fromConfiguration(fn: FunctionConfiguration, tags: Record<string, string> = {}): LambdaFunction {
  return {
    name: fn.FunctionName ?? '',
    arn: fn.FunctionArn ?? '',
    runtime: fn.Runtime ?? '',
    packageType: fn.PackageType ?? 'Zip',
    layers: (fn.Layers ?? []).map((l) => l.Arn ?? '').filter(Boolean),
    env: fn.Environment?.Error ? null : { ...(fn.Environment?.Variables ?? {}) },
    envError: fn.Environment?.Error?.Message ?? fn.Environment?.Error?.ErrorCode ?? '',
    revisionId: fn.RevisionId ?? '',
    lastModified: fn.LastModified ?? '',
    tags,
  };
}

export function isSupportedRuntime(runtime: string): boolean {
  const match = /^nodejs(\d+)\.x$/.exec(runtime);
  return !!match && Number(match[1]) >= MIN_NODE_MAJOR;
}

export const isIvyLayer = (arn: string) => arn.includes(`:layer:${LAYER_NAME}:`);

/** Layer ARNs without version: everything up to and including the layer name. */
export const layerBaseArn = (arn: string) => arn.slice(0, arn.lastIndexOf(':'));

function isAttached(fn: LambdaFunction): boolean {
  return fn.layers.some(isIvyLayer) || fn.env?.AWS_LAMBDA_EXEC_WRAPPER === EXEC_WRAPPER;
}

/** Removes the Ivy layer and the variables Ivy set, keeping everything else. */
export function detachUpdate(fn: LambdaFunction): FunctionUpdate {
  const env = { ...(fn.env ?? {}) };
  for (const key of IVY_ENV) delete env[key];
  if (env.AWS_LAMBDA_EXEC_WRAPPER === EXEC_WRAPPER) delete env.AWS_LAMBDA_EXEC_WRAPPER;
  return { layers: fn.layers.filter((arn) => !isIvyLayer(arn)), env };
}

function attachUpdate(fn: LambdaFunction, layerArn: string, ingest: IngestConfig): FunctionUpdate {
  return {
    layers: [...fn.layers.filter((arn) => !isIvyLayer(arn)), layerArn],
    env: {
      ...(fn.env ?? {}),
      AWS_LAMBDA_EXEC_WRAPPER: EXEC_WRAPPER,
      IVY_ENDPOINT: ingest.endpoint,
      IVY_API_KEY: ingest.apiKey,
    },
  };
}

function sameUpdate(fn: LambdaFunction, update: FunctionUpdate): boolean {
  const env = fn.env ?? {};
  const keys = new Set([...Object.keys(env), ...Object.keys(update.env)]);
  return (
    fn.layers.length === update.layers.length &&
    fn.layers.every((arn, i) => arn === update.layers[i]) &&
    [...keys].every((k) => env[k] === update.env[k])
  );
}

const plan = (state: TraceState, reason: string, update: FunctionUpdate | null = null): Plan => ({ state, reason, update });

/** Lets a function leave tracing: detaches when needed, otherwise just reports the state. */
function leave(fn: LambdaFunction, state: TraceState, reason: string): Plan {
  if (!isAttached(fn)) return plan(state, reason);
  if (!fn.env) return plan('error', `Can't read environment variables to detach: ${fn.envError}`);
  return plan(state, reason, detachUpdate(fn));
}

/**
 * Decides what to do with one function. Pure: the caller applies `update` with UpdateFunctionConfiguration.
 */
export function planFunction(fn: LambdaFunction, desired: Desired): Plan {
  if (fn.tags[COMPONENT_TAG]) return plan('unsupported', 'Part of the Ivy stack');
  if (fn.packageType === 'Image') return leave(fn, 'unsupported', 'Container image functions do not support layers');
  if (!isSupportedRuntime(fn.runtime)) {
    return leave(fn, 'unsupported', fn.runtime ? `Runtime ${fn.runtime} is not supported` : 'No managed runtime');
  }
  if (fn.tags[OPT_OUT_TAG]?.toLowerCase() === 'false') return leave(fn, 'opted_out', `Tagged ${OPT_OUT_TAG}=false`);
  if (!desired.enabled) return leave(fn, desired.offState ?? 'opted_out', desired.offReason ?? 'Not selected for tracing');

  if (!fn.env) return plan('error', `Can't read environment variables: ${fn.envError}`);
  const wrapper = fn.env.AWS_LAMBDA_EXEC_WRAPPER;
  if (wrapper && wrapper !== EXEC_WRAPPER) return plan('conflict', `AWS_LAMBDA_EXEC_WRAPPER is already set to ${wrapper}`);
  const otherLayers = fn.layers.filter((arn) => !isIvyLayer(arn));
  if (otherLayers.length >= MAX_LAYERS) return plan('conflict', `Already uses ${MAX_LAYERS} layers, the Lambda maximum`);

  if (!desired.ingest) return plan('pending', 'IVY_INGEST_PUBLIC_URL and IVY_INGEST_API_KEY must be set on the Ivy server');
  if (!desired.layerArn) return plan('pending', 'Layer not published in this region yet');

  const update = attachUpdate(fn, desired.layerArn, desired.ingest);
  if (sameUpdate(fn, update)) return plan('traced', '');
  return plan('traced', '', update);
}

/** True when the plan for this function would attach the layer (so the region needs a published layer). */
export function needsLayer(fn: LambdaFunction, enabled: boolean): boolean {
  const probe = planFunction(fn, { enabled, layerArn: 'probe', ingest: { endpoint: 'probe', apiKey: 'probe' } });
  return probe.state === 'traced';
}
