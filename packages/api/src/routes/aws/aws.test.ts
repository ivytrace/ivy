import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListFunctionsCommand,
  ListLayerVersionsCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { createApp } from '../../app.js';
import { resetAwsClientsForTests } from '../../lib/aws/clients.js';
import { resetLayerCacheForTests, setLayerZipForTests } from '../../lib/aws/lambda.js';
import { memoryStore } from '../../lib/aws/memory-store.js';
import { syncInProgress } from '../../lib/aws/scheduler.js';
import { setAwsStore } from '../../lib/aws/store.js';

const app = createApp({ uiDir: '/nonexistent', tenants: { resolve: async () => ({ id: 'default', shardId: 'shard-1' }) } });
const lambda = mockClient(LambdaClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
const sts = mockClient(STSClient);
const cloudwatch = mockClient(CloudWatchClient);

const ACCOUNT_ID = '123456789012';
const LAYER = `arn:aws:lambda:eu-west-1:${ACCOUNT_ID}:layer:ivy-trace-nodejs:1`;
const IVY_ENV = { AWS_LAMBDA_EXEC_WRAPPER: '/opt/ivy-wrapper', IVY_ENDPOINT: 'https://ingest.example.com', IVY_API_KEY: 'ingest-key' };
const fnArn = (name: string) => `arn:aws:lambda:eu-west-1:${ACCOUNT_ID}:function:${name}`;

const CREDS = {
  Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 3600_000) },
};

let mem: ReturnType<typeof memoryStore>;

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function connect() {
  const res = await app.request('/api/aws/accounts', json({ account_id: ACCOUNT_ID, regions: ['eu-west-1'], name: 'Prod' }));
  return (await res.json()) as Record<string, any>;
}

/** Waits for the background sync started by a route. */
async function settle(id: string) {
  const account = await mem.store.getAccount('default', id);
  if (account) await syncInProgress(account);
}

beforeEach(() => {
  lambda.reset();
  tagging.reset();
  sts.reset();
  cloudwatch.reset();
  cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });
  resetAwsClientsForTests();
  resetLayerCacheForTests();
  setLayerZipForTests({ bytes: new Uint8Array([1]), sha256: 'hash' });
  mem = memoryStore();
  setAwsStore(mem.store);
  vi.stubEnv('IVY_AWS_PRINCIPAL_ARN', 'arn:aws:iam::999999999999:role/ivy');
  vi.stubEnv('IVY_CFN_TEMPLATE_URL', 'https://bucket.s3.amazonaws.com/ivy-trace.yaml');
  vi.stubEnv('IVY_INGEST_PUBLIC_URL', 'https://ingest.example.com');
  vi.stubEnv('IVY_INGEST_API_KEY', 'ingest-key');
  vi.stubEnv('IVY_PUBLIC_URL', 'https://ivy.example.com');
  sts.on(AssumeRoleCommand).resolves(CREDS);
  tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
  lambda.on(ListLayerVersionsCommand).resolves({ LayerVersions: [{ LayerVersionArn: LAYER, Description: 'sha256:hash' }] });
  lambda.on(ListFunctionsCommand).resolves({
    Functions: [
      { FunctionName: 'orders', FunctionArn: fnArn('orders'), Runtime: 'nodejs22.x', RevisionId: 'r1' },
      { FunctionName: 'legacy', FunctionArn: fnArn('legacy'), Runtime: 'python3.12', RevisionId: 'r1' },
    ],
  });
  lambda.on(UpdateFunctionConfigurationCommand).resolves({});
});

afterAll(() => {
  vi.unstubAllEnvs();
  setLayerZipForTests(undefined);
});

describe('AWS account routes', () => {
  it('reports setup issues', async () => {
    vi.stubEnv('IVY_INGEST_PUBLIC_URL', '');
    vi.stubEnv('IVY_AWS_PRINCIPAL_ARN', '');
    sts.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:sts::999999999999:assumed-role/ivy-api/i-123' });
    const body = await (await app.request('/api/aws/setup')).json();
    expect(body.principal_arn).toBe('arn:aws:iam::999999999999:role/ivy-api');
    expect(body.events_url).toBe('https://ivy.example.com/api/aws/events');
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toContain('IVY_INGEST_PUBLIC_URL');
  });

  it('creates a pending connection with a quick-create link and unique external ID', async () => {
    const a = await connect();
    const b = await (await app.request('/api/aws/accounts', json({ account_id: '210987654321', all_regions: true, stack_region: 'us-east-1' }))).json();
    expect(a).toMatchObject({ status: 'pending', account_id: ACCOUNT_ID, regions: ['eu-west-1'], stack_region: 'eu-west-1', name: 'Prod' });
    expect(a.external_id).toMatch(/^ivy-[0-9a-f]{32}$/);
    expect(a.external_id).not.toBe(b.external_id);
    expect(a.role_arn).toMatch(new RegExp(`^arn:aws:iam::${ACCOUNT_ID}:role/IvyTrace-[0-9a-f]{8}$`));
    const params = new URLSearchParams(a.quick_create_url.split('?').pop());
    expect(params.get('param_ExternalId')).toBe(a.external_id);
    expect(params.get('param_EventsUrl')).toBe('https://ivy.example.com/api/aws/events');
    expect(b).toMatchObject({ all_regions: true, regions: [], stack_region: 'us-east-1' });
  });

  it('validates input and rejects duplicate accounts', async () => {
    expect((await app.request('/api/aws/accounts', json({ account_id: '123' }))).status).toBe(400);
    expect((await app.request('/api/aws/accounts', json({ account_id: ACCOUNT_ID, regions: ['mars-1'] }))).status).toBe(400);
    await connect();
    expect((await app.request('/api/aws/accounts', json({ account_id: ACCOUNT_ID }))).status).toBe(409);
  });

  it('has no quick-create link without a template URL, but a downloadable template', async () => {
    vi.stubEnv('IVY_CFN_TEMPLATE_URL', '');
    const a = await connect();
    expect(a.quick_create_url).toBeNull();
    const res = await app.request(a.template_download_url);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const doc = parse(await res.text());
    expect(doc.Parameters.ExternalId.Default).toBe(a.external_id);
    expect(doc.Parameters.RoleName.Default).toBe(a.role_arn.split('/').pop());
    expect(doc.Parameters.TrustedPrincipalArn.Default).toBe('arn:aws:iam::999999999999:role/ivy');

    const generic = parse(await (await app.request('/api/aws/template.yaml')).text());
    expect(generic.Parameters.ExternalId.Default).toBeUndefined();
  });

  it('verifies, syncs and lists functions with counts', async () => {
    const a = await connect();
    sts
      .on(AssumeRoleCommand)
      .rejectsOnce(Object.assign(new Error('not authorized to perform sts:AssumeRole'), { name: 'AccessDenied' }))
      .resolves(CREDS);
    const failed = await (await app.request(`/api/aws/accounts/${a.id}/verify`, { method: 'POST' })).json();
    expect(failed).toMatchObject({ verified: false, account: { status: 'pending' } });
    expect(failed.account.error).toContain('not authorized');

    const ok = await (await app.request(`/api/aws/accounts/${a.id}/verify`, { method: 'POST' })).json();
    expect(ok).toMatchObject({ verified: true, account: { status: 'connected', error: null } });
    await settle(a.id);

    const list = await (await app.request('/api/aws/accounts')).json();
    expect(list.items[0].counts).toMatchObject({ traced: 1, unsupported: 1, total: 2 });
    expect(list.items[0].last_sync_at).not.toBeNull();

    const fns = await (await app.request(`/api/aws/functions?account=${ACCOUNT_ID}`)).json();
    expect(fns.items.map((f: { name: string; state: string; tracing_enabled: boolean }) => [f.name, f.state, f.tracing_enabled])).toEqual([
      ['orders', 'traced', true],
      ['legacy', 'unsupported', true],
    ]);
  });

  it('opts a function out and back in', async () => {
    const a = await connect();
    await app.request(`/api/aws/accounts/${a.id}/verify`, { method: 'POST' });
    await settle(a.id);

    lambda.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: 'orders', FunctionArn: fnArn('orders'), Runtime: 'nodejs22.x', RevisionId: 'r2', Layers: [{ Arn: LAYER }], Environment: { Variables: IVY_ENV },
    });
    lambda.resetHistory();
    const off = await (await app.request(`/api/aws/functions/${ACCOUNT_ID}/eu-west-1/orders`, { ...json({ tracing_enabled: false }), method: 'PUT' })).json();
    expect(off).toMatchObject({ applied: true, function: { state: 'opted_out', tracing_enabled: false } });
    expect(lambda.commandCalls(UpdateFunctionConfigurationCommand)[0].args[0].input).toMatchObject({ Layers: [], Environment: { Variables: {} } });

    // The next full sync keeps it opted out.
    await settle(a.id);
    const fns = await (await app.request('/api/aws/functions')).json();
    expect(fns.items.find((f: { name: string }) => f.name === 'orders')).toMatchObject({ state: 'opted_out', tracing_enabled: false });

    const bad = await app.request(`/api/aws/functions/${ACCOUNT_ID}/eu-west-1/orders`, { ...json({ tracing_enabled: 'no' }), method: 'PUT' });
    expect(bad.status).toBe(400);
  });

  it('updates regions and deletes with detach', async () => {
    const a = await connect();
    await app.request(`/api/aws/accounts/${a.id}/verify`, { method: 'POST' });
    await settle(a.id);
    const patched = await (await app.request(`/api/aws/accounts/${a.id}`, { ...json({ regions: ['eu-west-1', 'us-east-1'] }), method: 'PATCH' })).json();
    expect(patched.regions).toEqual(['eu-west-1', 'us-east-1']);
    await settle(a.id);

    const res = await (await app.request(`/api/aws/accounts/${a.id}`, { method: 'DELETE' })).json();
    expect(res).toMatchObject({ deleted: true, detached: true });
    expect((await (await app.request('/api/aws/accounts')).json()).items).toEqual([]);
    expect((await (await app.request('/api/aws/functions')).json()).items).toEqual([]);
    expect((await app.request(`/api/aws/accounts/${a.id}`)).status).toBe(404);
  });

  it('turns throttle polling off and on, and reports a missing permission', async () => {
    const a = await connect();
    expect(a).toMatchObject({ throttle_metrics: true, throttle_status: null });
    cloudwatch.on(GetMetricDataCommand).rejects(Object.assign(new Error('not authorized to perform: cloudwatch:GetMetricData'), { name: 'AccessDenied' }));
    await app.request(`/api/aws/accounts/${a.id}/verify`, { method: 'POST' });
    await settle(a.id);
    const after = await (await app.request(`/api/aws/accounts/${a.id}`)).json();
    expect(after).toMatchObject({ status: 'connected', throttle_status: 'missing_permission' });

    const off = await (await app.request(`/api/aws/accounts/${a.id}`, { ...json({ throttle_metrics: false }), method: 'PATCH' })).json();
    expect(off.throttle_metrics).toBe(false);
    await settle(a.id);
    const bad = await app.request(`/api/aws/accounts/${a.id}`, { ...json({ throttle_metrics: 'no' }), method: 'PATCH' });
    expect(bad.status).toBe(400);
  });

  it('accepts EventBridge events only with the connection secret', async () => {
    const a = await connect();
    await app.request(`/api/aws/accounts/${a.id}/verify`, { method: 'POST' });
    await settle(a.id);
    const secret = (await mem.store.getAccount('default', a.id))!.event_secret;
    const event = { account: ACCOUNT_ID, region: 'eu-west-1', 'detail-type': 'AWS API Call via CloudTrail' };

    expect((await app.request('/api/aws/events', json(event))).status).toBe(401);
    const wrongAccount = { ...json({ ...event, account: '000000000000' }), headers: { 'content-type': 'application/json', 'x-ivy-event-secret': secret } };
    expect((await app.request('/api/aws/events', wrongAccount)).status).toBe(403);

    lambda.resetHistory();
    const ok = await app.request('/api/aws/events', { ...json(event), headers: { 'content-type': 'application/json', 'x-ivy-event-secret': secret } });
    expect(ok.status).toBe(202);
    await settle(a.id);
    expect(lambda.commandCalls(ListFunctionsCommand).length).toBeGreaterThan(0);
  });
});
