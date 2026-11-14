import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListFunctionsCommand,
  ListLayerVersionsCommand,
  PublishLayerVersionCommand,
  UpdateFunctionConfigurationCommand,
  type FunctionConfiguration,
} from '@aws-sdk/client-lambda';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAwsClientsForTests } from './clients.js';
import { applyUpdate, ensureLayer, resetLayerCacheForTests, setLayerZipForTests, sleep } from './lambda.js';
import { memoryStore } from './memory-store.js';
import { setAwsStore } from './store.js';
import { setThrottleSinkForTests } from './throttles.js';
import { detachAccount, syncAccount, syncFunction } from './sync.js';
import type { AwsAccount } from './types.js';

const lambda = mockClient(LambdaClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
const sts = mockClient(STSClient);
const cloudwatch = mockClient(CloudWatchClient);

const ACCOUNT_ID = '123456789012';
const LAYER_V1 = `arn:aws:lambda:eu-west-1:${ACCOUNT_ID}:layer:ivy-trace-nodejs:1`;
const LAYER_V2 = `arn:aws:lambda:eu-west-1:${ACCOUNT_ID}:layer:ivy-trace-nodejs:2`;
const ZIP = { bytes: new Uint8Array([1, 2, 3]), sha256: 'abc123' };
const arn = (name: string) => `arn:aws:lambda:eu-west-1:${ACCOUNT_ID}:function:${name}`;

const account: AwsAccount = {
  tenant_id: 'default',
  id: 'conn-1',
  name: 'Prod',
  account_id: ACCOUNT_ID,
  role_arn: `arn:aws:iam::${ACCOUNT_ID}:role/IvyTrace-abc`,
  external_id: 'ivy-ext',
  event_secret: 'secret',
  stack_name: 'ivy-trace-abc',
  stack_region: 'eu-west-1',
  regions: ['eu-west-1'],
  all_regions: false,
  status: 'connected',
  error: '',
  created_at: 1,
  verified_at: 1,
  last_sync_at: 0,
  throttle_metrics: true,
  throttle_status: '',
  throttles_polled_to: 0,
};

function config(name: string, extra: Partial<FunctionConfiguration> = {}): FunctionConfiguration {
  return { FunctionName: name, FunctionArn: arn(name), Runtime: 'nodejs22.x', RevisionId: `${name}-r1`, Environment: { Variables: {} }, ...extra };
}

const IVY_ENV = { AWS_LAMBDA_EXEC_WRAPPER: '/opt/ivy-wrapper', IVY_ENDPOINT: 'https://ingest.example.com', IVY_API_KEY: 'ingest-key' };

let mem: ReturnType<typeof memoryStore>;

beforeEach(() => {
  lambda.reset();
  tagging.reset();
  sts.reset();
  cloudwatch.reset();
  cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });
  setThrottleSinkForTests({ save: async () => {} });
  resetAwsClientsForTests();
  resetLayerCacheForTests();
  setLayerZipForTests(ZIP);
  mem = memoryStore();
  setAwsStore(mem.store);
  vi.stubEnv('IVY_INGEST_PUBLIC_URL', 'https://ingest.example.com/');
  vi.stubEnv('IVY_INGEST_API_KEY', 'ingest-key');
  vi.spyOn(sleep, 'wait').mockResolvedValue();
  sts.on(AssumeRoleCommand).resolves({
    Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'secret', SessionToken: 'token', Expiration: new Date(Date.now() + 3600_000) },
  });
  tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
});

afterAll(() => {
  setThrottleSinkForTests(undefined);
  vi.unstubAllEnvs();
  setLayerZipForTests(undefined);
});

describe('ensureLayer', () => {
  it('reuses a layer version with the same zip hash', async () => {
    lambda.on(ListLayerVersionsCommand).resolves({
      LayerVersions: [{ LayerVersionArn: LAYER_V2, Description: 'other' }, { LayerVersionArn: LAYER_V1, Description: 'Ivy sha256:abc123' }],
    });
    expect(await ensureLayer(new LambdaClient({}), ACCOUNT_ID, 'eu-west-1', ZIP)).toBe(LAYER_V1);
    expect(lambda.commandCalls(PublishLayerVersionCommand)).toHaveLength(0);
  });

  it('publishes when no version matches, once per account/region/hash', async () => {
    lambda.on(ListLayerVersionsCommand).resolves({ LayerVersions: [] });
    lambda.on(PublishLayerVersionCommand).resolves({ LayerVersionArn: LAYER_V2 });
    const client = new LambdaClient({});
    const [a, b] = await Promise.all([ensureLayer(client, ACCOUNT_ID, 'eu-west-1', ZIP), ensureLayer(client, ACCOUNT_ID, 'eu-west-1', ZIP)]);
    expect([a, b]).toEqual([LAYER_V2, LAYER_V2]);
    const calls = lambda.commandCalls(PublishLayerVersionCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({ LayerName: 'ivy-trace-nodejs', Content: { ZipFile: ZIP.bytes } });
    expect(calls[0].args[0].input.Description).toContain('sha256:abc123');
  });
});

describe('applyUpdate', () => {
  const fn = { name: 'a', arn: arn('a'), runtime: 'nodejs22.x', packageType: 'Zip', layers: [], env: {}, envError: '', revisionId: 'r1', tags: {} };

  it('retries while another update is in progress', async () => {
    const conflict = Object.assign(new Error('An update is in progress'), { name: 'ResourceConflictException' });
    lambda.on(UpdateFunctionConfigurationCommand).rejectsOnce(conflict).rejectsOnce(conflict).resolves({});
    await applyUpdate(new LambdaClient({}), fn, { layers: [LAYER_V1], env: { A: '1' } });
    const calls = lambda.commandCalls(UpdateFunctionConfigurationCommand);
    expect(calls).toHaveLength(3);
    expect(calls[0].args[0].input).toEqual({ FunctionName: arn('a'), Layers: [LAYER_V1], Environment: { Variables: { A: '1' } }, RevisionId: 'r1' });
  });

  it('gives up after a few conflicts and does not retry other errors', async () => {
    const conflict = Object.assign(new Error('busy'), { name: 'ResourceConflictException' });
    lambda.on(UpdateFunctionConfigurationCommand).rejects(conflict);
    await expect(applyUpdate(new LambdaClient({}), fn, { layers: [], env: {} })).rejects.toThrow('busy');
    expect(lambda.commandCalls(UpdateFunctionConfigurationCommand)).toHaveLength(5);

    lambda.reset();
    lambda.on(UpdateFunctionConfigurationCommand).rejects(Object.assign(new Error('nope'), { name: 'AccessDeniedException' }));
    await expect(applyUpdate(new LambdaClient({}), fn, { layers: [], env: {} })).rejects.toThrow('nope');
    expect(lambda.commandCalls(UpdateFunctionConfigurationCommand)).toHaveLength(1);
  });
});

describe('syncAccount', () => {
  beforeEach(async () => {
    await mem.store.saveAccount(account);
    lambda.on(ListLayerVersionsCommand).resolves({ LayerVersions: [{ LayerVersionArn: LAYER_V2, Description: 'sha256:abc123' }] });
    lambda.on(UpdateFunctionConfigurationCommand).resolves({});
  });

  it('attaches, upgrades, skips and opts out, and records each state', async () => {
    lambda.on(ListFunctionsCommand).resolvesOnce({ Functions: [config('new'), config('old', { Layers: [{ Arn: LAYER_V1 }], Environment: { Variables: IVY_ENV } })], NextMarker: 'm' }).resolvesOnce({
      Functions: [
        config('done', { Layers: [{ Arn: LAYER_V2 }], Environment: { Variables: IVY_ENV } }),
        config('py', { Runtime: 'python3.12' }),
        config('dd', { Environment: { Variables: { AWS_LAMBDA_EXEC_WRAPPER: '/opt/datadog_wrapper' } } }),
        config('tagged', { Layers: [{ Arn: LAYER_V1 }], Environment: { Variables: { ...IVY_ENV, KEEP: '1' } } }),
        config('muted'),
      ],
    });
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: arn('tagged'), Tags: [{ Key: 'ivy:trace', Value: 'false' }] }] });
    await mem.store.saveSetting('default', { account_id: ACCOUNT_ID, region: 'eu-west-1', function_name: 'muted', tracing_enabled: false });

    await syncAccount(account);

    const updates = Object.fromEntries(
      lambda.commandCalls(UpdateFunctionConfigurationCommand).map((c) => [c.args[0].input.FunctionName!.split(':').pop(), c.args[0].input]),
    );
    expect(Object.keys(updates).sort()).toEqual(['new', 'old', 'tagged']);
    expect(updates.new).toMatchObject({ Layers: [LAYER_V2], Environment: { Variables: IVY_ENV }, RevisionId: 'new-r1' });
    expect(updates.old.Layers).toEqual([LAYER_V2]);
    expect(updates.tagged).toMatchObject({ Layers: [], Environment: { Variables: { KEEP: '1' } } });

    const states = Object.fromEntries((await mem.store.listFunctions('default')).map((f) => [f.function_name, f.state]));
    expect(states).toEqual({ new: 'traced', old: 'traced', done: 'traced', py: 'unsupported', dd: 'conflict', tagged: 'opted_out', muted: 'opted_out' });

    const saved = await mem.store.getAccount('default', 'conn-1');
    expect(saved?.status).toBe('connected');
    expect(saved?.last_sync_at).toBeGreaterThan(0);
    expect(sts.commandCalls(AssumeRoleCommand)[0].args[0].input).toMatchObject({ RoleArn: account.role_arn, ExternalId: 'ivy-ext' });
  });

  it('is idempotent: a second run makes no updates', async () => {
    lambda.on(ListFunctionsCommand).resolves({ Functions: [config('done', { Layers: [{ Arn: LAYER_V2 }], Environment: { Variables: IVY_ENV } })] });
    await syncAccount(account);
    await syncAccount(account);
    expect(lambda.commandCalls(UpdateFunctionConfigurationCommand)).toHaveLength(0);
  });

  it('replans against the new revision when the function changed meanwhile', async () => {
    lambda.on(ListFunctionsCommand).resolves({ Functions: [config('a')] });
    lambda
      .on(UpdateFunctionConfigurationCommand)
      .rejectsOnce(Object.assign(new Error('revision'), { name: 'PreconditionFailedException' }))
      .resolves({});
    lambda.on(GetFunctionConfigurationCommand).resolves(config('a', { RevisionId: 'a-r2', Environment: { Variables: { NEW: '1' } } }));
    await syncAccount(account);
    const calls = lambda.commandCalls(UpdateFunctionConfigurationCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input).toMatchObject({ RevisionId: 'a-r2', Environment: { Variables: { NEW: '1', ...IVY_ENV } } });
  });

  it('does not attach to new functions when tags are unreadable', async () => {
    lambda.on(ListFunctionsCommand).resolves({ Functions: [config('a')] });
    tagging.on(GetResourcesCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await syncAccount(account);
    expect(lambda.commandCalls(UpdateFunctionConfigurationCommand)).toHaveLength(0);
    expect((await mem.store.listFunctions('default'))[0].state).toBe('pending');
  });

  it('publishes the layer only when some function needs it', async () => {
    lambda.on(ListFunctionsCommand).resolves({ Functions: [config('py', { Runtime: 'python3.12' })] });
    await syncAccount(account);
    expect(lambda.commandCalls(ListLayerVersionsCommand)).toHaveLength(0);
  });

  it('marks the account as errored when the role cannot be assumed', async () => {
    sts.on(AssumeRoleCommand).rejects(Object.assign(new Error('not authorized'), { name: 'AccessDenied' }));
    await syncAccount(account);
    const saved = await mem.store.getAccount('default', 'conn-1');
    expect(saved?.status).toBe('error');
    expect(saved?.error).toContain('not authorized');
  });

  it('skips regions that are not enabled when scanning all regions, but reports them otherwise', async () => {
    const disabled = Object.assign(new Error('The security token included in the request is invalid'), { name: 'UnrecognizedClientException' });
    lambda.on(ListFunctionsCommand).rejects(disabled);
    await syncAccount({ ...account, all_regions: true });
    expect((await mem.store.getAccount('default', 'conn-1'))?.error).toBe('');

    await syncAccount({ ...account, regions: ['eu-west-1', 'ap-east-1'] });
    expect((await mem.store.getAccount('default', 'conn-1'))?.error).toContain('ap-east-1: The security token');
  });

  it('polls throttles after the function sync, and only when the account allows it', async () => {
    lambda.on(ListFunctionsCommand).resolves({ Functions: [config('a')] });
    await syncAccount({ ...account, throttle_metrics: false });
    expect(cloudwatch.commandCalls(GetMetricDataCommand)).toHaveLength(0);
    expect((await mem.store.getAccount('default', 'conn-1'))?.throttle_status).toBe('');

    await syncAccount(account);
    expect(cloudwatch.commandCalls(GetMetricDataCommand)).toHaveLength(1);
    const saved = await mem.store.getAccount('default', 'conn-1');
    expect(saved?.throttle_status).toBe('ok');
    expect(saved?.throttles_polled_to).toBeGreaterThan(0);
  });

  it('keeps syncing functions when the role lacks cloudwatch:GetMetricData', async () => {
    cloudwatch.on(GetMetricDataCommand).rejects(Object.assign(new Error('not authorized to perform: cloudwatch:GetMetricData'), { name: 'AccessDenied' }));
    lambda.on(ListFunctionsCommand).resolves({ Functions: [config('a')] });
    await syncAccount(account);
    const saved = await mem.store.getAccount('default', 'conn-1');
    expect(saved).toMatchObject({ status: 'connected', error: '', throttle_status: 'missing_permission', throttles_polled_to: 0 });
    expect((await mem.store.listFunctions('default')).map((f) => f.state)).toEqual(['traced']);
  });

  it('removes functions that no longer exist', async () => {
    lambda.on(ListFunctionsCommand).resolvesOnce({ Functions: [config('a'), config('b')] }).resolves({ Functions: [config('a')] });
    await syncAccount(account);
    await syncAccount(account);
    expect((await mem.store.listFunctions('default')).map((f) => f.function_name)).toEqual(['a']);
  });
});

describe('syncFunction and detachAccount', () => {
  it('applies a dashboard toggle to a single function', async () => {
    lambda.on(GetFunctionConfigurationCommand).resolves(config('a', { Layers: [{ Arn: LAYER_V2 }], Environment: { Variables: { ...IVY_ENV, X: '1' } } }));
    lambda.on(UpdateFunctionConfigurationCommand).resolves({});
    const row = await syncFunction(account, 'eu-west-1', 'a', false);
    expect(row.state).toBe('opted_out');
    expect(lambda.commandCalls(UpdateFunctionConfigurationCommand)[0].args[0].input).toMatchObject({ Layers: [], Environment: { Variables: { X: '1' } } });
  });

  it('detaches every traced function', async () => {
    lambda.on(ListFunctionsCommand).resolves({
      Functions: [config('a', { Layers: [{ Arn: LAYER_V2 }], Environment: { Variables: IVY_ENV } }), config('b')],
    });
    lambda.on(UpdateFunctionConfigurationCommand).resolves({});
    expect(await detachAccount(account)).toEqual([]);
    const calls = lambda.commandCalls(UpdateFunctionConfigurationCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({ FunctionName: arn('a'), Layers: [], Environment: { Variables: {} } });
  });
});
