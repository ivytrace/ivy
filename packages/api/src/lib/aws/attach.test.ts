import { describe, expect, it } from 'vitest';
import { detachUpdate, fromConfiguration, isSupportedRuntime, needsLayer, planFunction, type Desired, type LambdaFunction } from './attach.js';

const LAYER = 'arn:aws:lambda:eu-west-1:123456789012:layer:ivy-trace-nodejs:3';
const OLD_LAYER = 'arn:aws:lambda:eu-west-1:123456789012:layer:ivy-trace-nodejs:2';
const OTHER = (n: number) => `arn:aws:lambda:eu-west-1:123456789012:layer:other-${n}:1`;
const ingest = { endpoint: 'https://ingest.example.com', apiKey: 'key-1' };
const desired: Desired = { enabled: true, layerArn: LAYER, ingest };
const IVY_ENV = { AWS_LAMBDA_EXEC_WRAPPER: '/opt/ivy-wrapper', IVY_ENDPOINT: ingest.endpoint, IVY_API_KEY: ingest.apiKey };

function fn(overrides: Partial<LambdaFunction> = {}): LambdaFunction {
  return {
    name: 'orders',
    arn: 'arn:aws:lambda:eu-west-1:123456789012:function:orders',
    runtime: 'nodejs22.x',
    packageType: 'Zip',
    layers: [],
    env: { TABLE: 'orders' },
    envError: '',
    revisionId: 'rev-1',
    lastModified: '',
    tags: {},
    ...overrides,
  };
}

describe('isSupportedRuntime', () => {
  it('accepts nodejs18.x and later only', () => {
    expect(['nodejs18.x', 'nodejs20.x', 'nodejs22.x', 'nodejs24.x'].every(isSupportedRuntime)).toBe(true);
    expect(['nodejs16.x', 'nodejs14.x', 'python3.12', 'provided.al2023', ''].some(isSupportedRuntime)).toBe(false);
  });
});

describe('planFunction', () => {
  it('attaches the layer and env vars, keeping existing layers and variables', () => {
    const plan = planFunction(fn({ layers: [OTHER(1)] }), desired);
    expect(plan.state).toBe('traced');
    expect(plan.update).toEqual({ layers: [OTHER(1), LAYER], env: { TABLE: 'orders', ...IVY_ENV } });
  });

  it('does nothing when the function is already traced with the current layer', () => {
    const plan = planFunction(fn({ layers: [OTHER(1), LAYER], env: { TABLE: 'x', ...IVY_ENV } }), desired);
    expect(plan).toEqual({ state: 'traced', reason: '', update: null });
  });

  it('replaces an older Ivy layer version in place of adding a second one', () => {
    const plan = planFunction(fn({ layers: [OLD_LAYER, OTHER(1)], env: { ...IVY_ENV } }), desired);
    expect(plan.update?.layers).toEqual([OTHER(1), LAYER]);
  });

  it('updates the endpoint and key when they changed', () => {
    const plan = planFunction(fn({ layers: [LAYER], env: { ...IVY_ENV, IVY_API_KEY: 'old' } }), desired);
    expect(plan.update?.env.IVY_API_KEY).toBe('key-1');
  });

  it('reports unsupported runtimes and container images without touching them', () => {
    expect(planFunction(fn({ runtime: 'python3.12' }), desired)).toMatchObject({ state: 'unsupported', update: null });
    expect(planFunction(fn({ runtime: 'nodejs16.x' }), desired)).toMatchObject({ state: 'unsupported', update: null });
    expect(planFunction(fn({ runtime: '', packageType: 'Image' }), desired)).toMatchObject({ state: 'unsupported', update: null });
  });

  it('reports a conflict for another exec wrapper', () => {
    const plan = planFunction(fn({ env: { AWS_LAMBDA_EXEC_WRAPPER: '/opt/datadog_wrapper' } }), desired);
    expect(plan).toMatchObject({ state: 'conflict', update: null });
    expect(plan.reason).toContain('/opt/datadog_wrapper');
  });

  it('reports a conflict when five other layers are attached, but not when one of them is Ivy', () => {
    const five = [1, 2, 3, 4, 5].map(OTHER);
    expect(planFunction(fn({ layers: five }), desired)).toMatchObject({ state: 'conflict', update: null });
    const fourPlusIvy = [...[1, 2, 3, 4].map(OTHER), OLD_LAYER];
    expect(planFunction(fn({ layers: fourPlusIvy, env: IVY_ENV }), desired).update?.layers).toEqual([...[1, 2, 3, 4].map(OTHER), LAYER]);
  });

  it('skips Ivy components', () => {
    expect(planFunction(fn({ tags: { 'ivy:component': 'collector' } }), desired)).toMatchObject({ state: 'unsupported', update: null });
  });

  it('opts out by tag, and detaches cleanly when not selected (available) or excluded', () => {
    const traced = fn({ layers: [OTHER(1), LAYER], env: { TABLE: 'x', IVY_REDACT_KEYS: 'secret', ...IVY_ENV } });
    const expected = { layers: [OTHER(1)], env: { TABLE: 'x', IVY_REDACT_KEYS: 'secret' } };

    const byTag = planFunction({ ...traced, tags: { 'ivy:trace': 'false' } }, desired);
    expect(byTag).toMatchObject({ state: 'opted_out', update: expected });
    expect(byTag.reason).toContain('ivy:trace=false');

    const excluded = planFunction(traced, { ...desired, enabled: false, offState: 'opted_out', offReason: 'Excluded in the dashboard' });
    expect(excluded).toMatchObject({ state: 'opted_out', reason: 'Excluded in the dashboard', update: expected });

    const unmatched = planFunction(traced, { ...desired, enabled: false, offState: 'available', offReason: 'Not selected for tracing' });
    expect(unmatched).toMatchObject({ state: 'available', update: expected });

    expect(planFunction(fn(), { ...desired, enabled: false, offState: 'available' })).toEqual({ state: 'available', reason: 'Not selected for tracing', update: null });
  });

  it('keeps a foreign exec wrapper when detaching', () => {
    const update = detachUpdate(fn({ layers: [LAYER], env: { AWS_LAMBDA_EXEC_WRAPPER: '/opt/other', IVY_ENDPOINT: 'x' } }));
    expect(update).toEqual({ layers: [], env: { AWS_LAMBDA_EXEC_WRAPPER: '/opt/other' } });
  });

  it('refuses to write when the environment could not be read', () => {
    const plan = planFunction(fn({ env: null, envError: 'KMS AccessDenied' }), desired);
    expect(plan).toMatchObject({ state: 'error', update: null });
    expect(plan.reason).toContain('KMS AccessDenied');
  });

  it('waits for ingest config and a published layer', () => {
    expect(planFunction(fn(), { ...desired, ingest: null })).toMatchObject({ state: 'pending', update: null });
    expect(planFunction(fn(), { ...desired, layerArn: null })).toMatchObject({ state: 'pending', update: null });
  });
});

describe('force install', () => {
  const LUMIGO = '/opt/lumigo_wrapper';
  const lumigo = (env: Record<string, string> = {}) => fn({ layers: [OTHER(1)], env: { TABLE: 'x', AWS_LAMBDA_EXEC_WRAPPER: LUMIGO, LUMIGO_TRACER_TOKEN: 't', ...env } });
  const forced = { ...desired, force: true };
  const FORCED_ENV = { TABLE: 'x', LUMIGO_TRACER_TOKEN: 't', ...IVY_ENV, IVY_PREVIOUS_EXEC_WRAPPER: LUMIGO };

  it('replaces the other wrapper, keeps it in IVY_PREVIOUS_EXEC_WRAPPER, and leaves the other layer and variables', () => {
    expect(planFunction(lumigo(), desired)).toMatchObject({ state: 'conflict', conflict: 'wrapper', wrapper: LUMIGO, update: null });
    expect(needsLayer(lumigo())).toBe(false);
    expect(needsLayer(lumigo(), { force: true })).toBe(true);

    const plan = planFunction(lumigo(), forced);
    expect(plan).toMatchObject({ state: 'traced', wrapper: LUMIGO });
    expect(plan.update).toEqual({ layers: [OTHER(1), LAYER], env: FORCED_ENV });
    expect(planFunction(fn({ layers: [OTHER(1), LAYER], env: FORCED_ENV }), forced)).toEqual({ state: 'traced', reason: '', update: null, wrapper: LUMIGO });
  });

  it('restores the replaced wrapper when Ivy detaches', () => {
    const attached = fn({ layers: [OTHER(1), LAYER], env: FORCED_ENV });
    const restored = { layers: [OTHER(1)], env: { TABLE: 'x', LUMIGO_TRACER_TOKEN: 't', AWS_LAMBDA_EXEC_WRAPPER: LUMIGO } };
    expect(detachUpdate(attached)).toEqual(restored);
    expect(planFunction(attached, { ...forced, enabled: false, offState: 'available' })).toMatchObject({ state: 'available', update: restored });
    expect(planFunction({ ...attached, runtime: 'nodejs16.x' }, forced)).toMatchObject({ state: 'unsupported', update: restored });
  });

  it('hands the wrapper back when force is turned off', () => {
    const plan = planFunction(fn({ layers: [OTHER(1), LAYER], env: FORCED_ENV }), desired);
    expect(plan).toMatchObject({ state: 'conflict', conflict: 'wrapper', wrapper: LUMIGO });
    expect(plan.update?.env.AWS_LAMBDA_EXEC_WRAPPER).toBe(LUMIGO);
    expect(plan.update?.env).not.toHaveProperty('IVY_PREVIOUS_EXEC_WRAPPER');
  });

  it('lets ivy:trace=false win over force', () => {
    expect(planFunction({ ...lumigo(), tags: { 'ivy:trace': 'false' } }, forced)).toMatchObject({ state: 'opted_out', update: null });
    const attached = fn({ layers: [LAYER], env: FORCED_ENV, tags: { 'ivy:trace': 'false' } });
    expect(planFunction(attached, forced).update?.env.AWS_LAMBDA_EXEC_WRAPPER).toBe(LUMIGO);
  });

  it('stands down when the other tracer sets its wrapper back, and forces again only on retry', () => {
    const reapplied = fn({ layers: [OTHER(1), LAYER], env: { ...FORCED_ENV, AWS_LAMBDA_EXEC_WRAPPER: LUMIGO } });
    const plan = planFunction(reapplied, forced);
    expect(plan).toMatchObject({ state: 'conflict', conflict: 'reapplied', wrapper: LUMIGO });
    expect(plan.reason).toContain('set back to /opt/lumigo_wrapper');
    // Ivy's layer and variables go; the record of the replaced wrapper stays, so the next sync doesn't fight.
    expect(plan.update).toEqual({ layers: [OTHER(1)], env: { TABLE: 'x', LUMIGO_TRACER_TOKEN: 't', AWS_LAMBDA_EXEC_WRAPPER: LUMIGO, IVY_PREVIOUS_EXEC_WRAPPER: LUMIGO } });
    expect(planFunction(fn(plan.update!), forced)).toMatchObject({ state: 'conflict', conflict: 'reapplied', update: null });

    expect(planFunction(fn(plan.update!), { ...forced, retryForce: true })).toMatchObject({ state: 'traced', update: { env: FORCED_ENV } });
  });

  it('does not force past the layer limit', () => {
    const full = fn({ layers: [1, 2, 3, 4, 5].map(OTHER), env: { AWS_LAMBDA_EXEC_WRAPPER: LUMIGO } });
    expect(planFunction(full, forced)).toMatchObject({ state: 'conflict', conflict: 'layers', update: null });
  });
});

describe('fromConfiguration', () => {
  it('maps a ListFunctions item', () => {
    const f = fromConfiguration(
      {
        FunctionName: 'a',
        FunctionArn: 'arn:a',
        Runtime: 'nodejs20.x',
        Layers: [{ Arn: LAYER }],
        Environment: { Variables: { A: '1' } },
        RevisionId: 'r',
        LastModified: '2026-11-10T09:12:44.000+0000',
      },
      { team: 'x' },
    );
    expect(f).toMatchObject({ name: 'a', layers: [LAYER], env: { A: '1' }, revisionId: 'r', lastModified: '2026-11-10T09:12:44.000+0000', tags: { team: 'x' }, packageType: 'Zip' });
    expect(fromConfiguration({ FunctionName: 'b' }).env).toEqual({});
    expect(fromConfiguration({ FunctionName: 'c', Environment: { Error: { ErrorCode: 'KMSAccessDenied' } } }).env).toBeNull();
  });
});
