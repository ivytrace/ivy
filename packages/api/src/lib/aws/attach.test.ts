import { describe, expect, it } from 'vitest';
import { detachUpdate, fromConfiguration, isSupportedRuntime, planFunction, type Desired, type LambdaFunction } from './attach.js';

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

  it('opts out by tag and by dashboard setting, detaching cleanly', () => {
    const traced = fn({ layers: [OTHER(1), LAYER], env: { TABLE: 'x', IVY_REDACT_KEYS: 'secret', ...IVY_ENV } });
    const expected = { layers: [OTHER(1)], env: { TABLE: 'x', IVY_REDACT_KEYS: 'secret' } };

    const byTag = planFunction({ ...traced, tags: { 'ivy:trace': 'false' } }, desired);
    expect(byTag).toMatchObject({ state: 'opted_out', update: expected });
    expect(byTag.reason).toContain('ivy:trace=false');

    const byDashboard = planFunction(traced, { ...desired, enabled: false });
    expect(byDashboard).toMatchObject({ state: 'opted_out', reason: 'Turned off in the dashboard', update: expected });

    expect(planFunction(fn(), { ...desired, enabled: false })).toEqual({ state: 'opted_out', reason: 'Turned off in the dashboard', update: null });
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
      },
      { team: 'x' },
    );
    expect(f).toMatchObject({ name: 'a', layers: [LAYER], env: { A: '1' }, revisionId: 'r', tags: { team: 'x' }, packageType: 'Zip' });
    expect(fromConfiguration({ FunctionName: 'b' }).env).toEqual({});
    expect(fromConfiguration({ FunctionName: 'c', Environment: { Error: { ErrorCode: 'KMSAccessDenied' } } }).env).toBeNull();
  });
});
