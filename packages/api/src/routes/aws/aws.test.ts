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
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { createApp } from '../../app.js';
import { resetAwsClientsForTests } from '../../lib/aws/clients.js';
import { resetLayerCacheForTests, setLayerZipForTests } from '../../lib/aws/lambda.js';
import { memoryStore } from '../../lib/aws/memory-store.js';
import { syncInProgress } from '../../lib/aws/scheduler.js';
import { setAwsStore } from '../../lib/aws/store.js';
import { appFor, DEFAULT_PROJECT, resetTenancyForTests } from '../../lib/tenancy/testing.js';

let app: ReturnType<typeof createApp>;
const lambda = mockClient(LambdaClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
const sts = mockClient(STSClient);

const ACCOUNT_ID = '123456789012';
const LAYER = `arn:aws:lambda:eu-west-1:${ACCOUNT_ID}:layer:ivy-trace-nodejs:1`;
const IVY_ENV = { AWS_LAMBDA_EXEC_WRAPPER: '/opt/ivy-wrapper', IVY_ENDPOINT: 'https://ingest.example.com', IVY_API_KEY: 'ingest-key' };
const fnArn = (name: string) => `arn:aws:lambda:eu-west-1:${ACCOUNT_ID}:function:${name}`;
const W = '/api/w/default/aws';

const CREDS = {
  Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 3600_000) },
};

let mem: ReturnType<typeof memoryStore>;

const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const req = async (path: string, init?: RequestInit) => (await app.request(path, init)).json() as Promise<Record<string, any>>;

async function connect() {
  const res = await app.request(`${W}/accounts`, json({ account_id: ACCOUNT_ID, regions: ['eu-west-1'], name: 'Prod' }));
  return (await res.json()) as Record<string, any>;
}

/** Waits for the background sync started by a route. */
async function settle(id: string) {
  const account = await mem.store.getAccount('default', id);
  if (account) await syncInProgress(account);
}

async function connected() {
  const a = await connect();
  await app.request(`${W}/accounts/${a.id}/verify`, { method: 'POST' });
  await settle(a.id);
  return a;
}

const stackTag = (name: string, stack: string) => ({ ResourceARN: fnArn(name), Tags: [{ Key: 'aws:cloudformation:stack-name', Value: stack }] });

beforeEach(async () => {
  await resetTenancyForTests();
  app = await appFor();
  lambda.reset();
  tagging.reset();
  sts.reset();
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
  tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [stackTag('orders', 'shop-prod'), stackTag('payments', 'shop-prod'), stackTag('stage-orders', 'shop-staging')] });
  lambda.on(ListLayerVersionsCommand).resolves({ LayerVersions: [{ LayerVersionArn: LAYER, Description: 'sha256:hash' }] });
  lambda.on(ListFunctionsCommand).resolves({
    Functions: [
      { FunctionName: 'orders', FunctionArn: fnArn('orders'), Runtime: 'nodejs22.x', RevisionId: 'r1' },
      { FunctionName: 'payments', FunctionArn: fnArn('payments'), Runtime: 'nodejs22.x', RevisionId: 'r1' },
      { FunctionName: 'stage-orders', FunctionArn: fnArn('stage-orders'), Runtime: 'nodejs22.x', RevisionId: 'r1' },
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
    const body = await req(`${W}/setup`);
    expect(body.principal_arn).toBe('arn:aws:iam::999999999999:role/ivy-api');
    expect(body.events_url).toBe('https://ivy.example.com/api/aws/events');
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toContain('IVY_INGEST_PUBLIC_URL');
  });

  it('creates a pending connection with a quick-create link and unique external ID', async () => {
    const a = await connect();
    const b = await req(`${W}/accounts`, json({ account_id: '210987654321', all_regions: true, stack_region: 'us-east-1', default_project: 'default' }));
    expect(a).toMatchObject({ status: 'pending', account_id: ACCOUNT_ID, regions: ['eu-west-1'], stack_region: 'eu-west-1', name: 'Prod', default_project: null });
    expect(a.external_id).toMatch(/^ivy-[0-9a-f]{32}$/);
    expect(a.external_id).not.toBe(b.external_id);
    expect(a.role_arn).toMatch(new RegExp(`^arn:aws:iam::${ACCOUNT_ID}:role/IvyTrace-[0-9a-f]{8}$`));
    const params = new URLSearchParams(a.quick_create_url.split('?').pop());
    expect(params.get('param_ExternalId')).toBe(a.external_id);
    expect(params.get('param_EventsUrl')).toBe('https://ivy.example.com/api/aws/events');
    expect(b).toMatchObject({ all_regions: true, regions: [], stack_region: 'us-east-1', default_project: 'default', default_project_id: DEFAULT_PROJECT });
  });

  it('validates input and rejects duplicate accounts', async () => {
    expect((await app.request(`${W}/accounts`, json({ account_id: '123' }))).status).toBe(400);
    expect((await app.request(`${W}/accounts`, json({ account_id: ACCOUNT_ID, regions: ['mars-1'] }))).status).toBe(400);
    expect((await app.request(`${W}/accounts`, json({ account_id: ACCOUNT_ID, default_project: 'nope' }))).status).toBe(400);
    await connect();
    expect((await app.request(`${W}/accounts`, json({ account_id: ACCOUNT_ID }))).status).toBe(409);
  });

  it('has no quick-create link without a template URL, but a downloadable template', async () => {
    vi.stubEnv('IVY_CFN_TEMPLATE_URL', '');
    const a = await connect();
    expect(a.quick_create_url).toBeNull();
    expect(a.template_download_url).toMatch(/^\/api\/w\/default\/aws\/template\.yaml\?account=/);
    const res = await app.request(a.template_download_url);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const doc = parse(await res.text());
    expect(doc.Parameters.ExternalId.Default).toBe(a.external_id);
    expect(doc.Parameters.RoleName.Default).toBe(a.role_arn.split('/').pop());
    expect(doc.Parameters.TrustedPrincipalArn.Default).toBe('arn:aws:iam::999999999999:role/ivy');

    const generic = parse(await (await app.request(`${W}/template.yaml`)).text());
    expect(generic.Parameters.ExternalId.Default).toBeUndefined();
  });

  it('verifies and syncs, tracing nothing: functions are available, grouped by stack, and counted as new', async () => {
    const a = await connect();
    sts
      .on(AssumeRoleCommand)
      .rejectsOnce(Object.assign(new Error('not authorized to perform sts:AssumeRole'), { name: 'AccessDenied' }))
      .resolves(CREDS);
    const failed = await req(`${W}/accounts/${a.id}/verify`, { method: 'POST' });
    expect(failed).toMatchObject({ verified: false, account: { status: 'pending' } });
    expect(failed.account.error).toContain('not authorized');

    const ok = await req(`${W}/accounts/${a.id}/verify`, { method: 'POST' });
    expect(ok).toMatchObject({ verified: true, account: { status: 'connected', error: null } });
    await settle(a.id);
    expect(lambda.commandCalls(UpdateFunctionConfigurationCommand)).toHaveLength(0);

    const list = await req(`${W}/accounts`);
    expect(list.items[0].counts).toMatchObject({ traced: 0, available: 3, unsupported: 1, total: 4, new: 3 });

    const grouped = await req(`${W}/accounts/${a.id}/functions`);
    expect(grouped.groups.map((g: any) => [g.stack, g.region, g.counts.total, g.suggested_project])).toEqual([
      ['shop-prod', 'eu-west-1', 2, 'shop-prod'],
      ['shop-staging', 'eu-west-1', 1, 'shop-staging'],
      [null, null, 1, null],
    ]);
    expect(grouped.groups[0].functions[0]).toMatchObject({ name: 'orders', state: 'available', stack: 'shop-prod', new: true, project: null });

    const reviewed = await req(`${W}/accounts/${a.id}`, json({ reviewed: true }, 'PATCH'));
    expect(reviewed.counts.new).toBe(0);
  });

  it('traces a stack into a new project with a rule, after a dry run, and detaches when the rule goes', async () => {
    vi.stubEnv('IVY_SECRET_KEY', 'server-secret');
    const a = await connected();
    const preview = await req(`${W}/rules/dry-run`, json({ matcher: { stack: 'shop-prod' }, project: 'shop-prod' }));
    expect(preview).toMatchObject({ count: 2, summary: { trace: 2, unchanged: 0, excluded: 0, other: 0, unsupported: 0 } });
    expect(preview.items.map((i: any) => [i.function.name, i.outcome, i.project])).toEqual([
      ['orders', 'trace', 'shop-prod'],
      ['payments', 'trace', 'shop-prod'],
    ]);
    expect(await mem.store.listRules('default')).toEqual([]);

    const created = await app.request(`${W}/rules`, json({ matcher: { stack: 'shop-prod' }, new_project: { name: 'Shop (prod)', slug: 'shop-prod' } }));
    expect(created.status).toBe(201);
    const { rule, project } = (await created.json()) as Record<string, any>;
    expect(project).toMatchObject({ slug: 'shop-prod', name: 'Shop (prod)' });
    expect(rule).toMatchObject({ matcher: { stack: 'shop-prod', name: null }, project: 'shop-prod', enabled: true, position: 0 });
    await settle(a.id);
    const updated = lambda.commandCalls(UpdateFunctionConfigurationCommand).map((c) => c.args[0].input.FunctionName!.split(':').pop());
    expect(updated.sort()).toEqual(['orders', 'payments']);

    const grouped = await req(`${W}/accounts/${a.id}/functions`);
    expect(grouped.groups[0]).toMatchObject({ stack: 'shop-prod', counts: { traced: 2 }, rule: { id: rule.id, project: 'shop-prod' } });
    expect(grouped.groups[0].functions[0]).toMatchObject({ state: 'traced', project: 'shop-prod', source: 'rule', rule_id: rule.id });
    expect((await req(`${W}/functions?project=shop-prod`)).items).toHaveLength(2);

    // Once traced, the dry run reports them as unchanged.
    expect((await req(`${W}/rules/dry-run`, json({ matcher: { stack: 'shop-prod' }, project: 'shop-prod' }))).summary.unchanged).toBe(2);
    expect((await req(`${W}/rules`)).items).toHaveLength(1);

    lambda.on(ListFunctionsCommand).resolves({
      Functions: [
        { FunctionName: 'orders', FunctionArn: fnArn('orders'), Runtime: 'nodejs22.x', RevisionId: 'r2', Layers: [{ Arn: LAYER }], Environment: { Variables: IVY_ENV } },
      ],
    });
    lambda.resetHistory();
    expect(await req(`${W}/rules/${rule.id}`, { method: 'DELETE' })).toEqual({ deleted: true });
    await settle(a.id);
    expect(lambda.commandCalls(UpdateFunctionConfigurationCommand)[0].args[0].input).toMatchObject({ Layers: [], Environment: { Variables: {} } });
    expect((await req(`${W}/functions`)).items[0]).toMatchObject({ name: 'orders', state: 'available' });
  });

  it('validates rules', async () => {
    expect((await app.request(`${W}/rules`, json({ matcher: {} }))).status).toBe(400);
    expect((await app.request(`${W}/rules`, json({ matcher: { region: 'mars-1' } }))).status).toBe(400);
    expect((await app.request(`${W}/rules`, json({ matcher: { name: '*' }, project: 'nope' }))).status).toBe(400);
    expect((await app.request(`${W}/rules/dry-run`, json({ matcher: 'x' }))).status).toBe(400);
    expect((await app.request(`${W}/rules/rul_nope`, { method: 'DELETE' })).status).toBe(404);
    const a = (await req(`${W}/rules`, json({ matcher: { name: 'a-*' } }))).rule;
    const b = (await req(`${W}/rules`, json({ matcher: { name: 'b-*' }, enabled: false }))).rule;
    expect(a.project_id).toBe(DEFAULT_PROJECT);
    expect((await req(`${W}/rules/order`, json({ order: [b.id, a.id] }, 'PUT'))).items.map((r: any) => r.id)).toEqual([b.id, a.id]);
    expect(await req(`${W}/rules/${b.id}`, json({ enabled: true, matcher: { name: 'b-*', region: 'eu-west-1' } }, 'PATCH'))).toMatchObject({
      enabled: true,
      position: 0,
      matcher: { name: 'b-*', region: 'eu-west-1' },
    });
  });

  it('applies a manual choice per function: trace into a project, exclude, back to rules', async () => {
    const a = await connected();
    const put = (body: unknown) => req(`${W}/functions/${ACCOUNT_ID}/eu-west-1/orders`, json(body, 'PUT'));
    lambda.on(GetFunctionConfigurationCommand).resolves({ FunctionName: 'orders', FunctionArn: fnArn('orders'), Runtime: 'nodejs22.x', RevisionId: 'r2' });

    const on = await put({ mode: 'trace', project: 'default' });
    expect(on).toMatchObject({ applied: true, function: { state: 'traced', project: 'default', source: 'manual', manual: { mode: 'trace', project: 'default' } } });
    expect(lambda.commandCalls(UpdateFunctionConfigurationCommand)[0].args[0].input).toMatchObject({ Layers: [LAYER], Environment: { Variables: IVY_ENV } });

    lambda.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: 'orders', FunctionArn: fnArn('orders'), Runtime: 'nodejs22.x', RevisionId: 'r3', Layers: [{ Arn: LAYER }], Environment: { Variables: IVY_ENV },
    });
    lambda.resetHistory();
    expect(await put({ mode: 'exclude' })).toMatchObject({ applied: true, function: { state: 'opted_out', source: 'manual', manual: { mode: 'exclude' } } });
    expect(lambda.commandCalls(UpdateFunctionConfigurationCommand)[0].args[0].input).toMatchObject({ Layers: [], Environment: { Variables: {} } });

    // A full sync keeps it excluded, even with a catch-all rule.
    await req(`${W}/rules`, json({ matcher: { name: '*' } }));
    await settle(a.id);
    const fns = (await req(`${W}/functions`)).items;
    expect(fns.find((f: any) => f.name === 'orders')).toMatchObject({ state: 'opted_out' });
    expect(fns.find((f: any) => f.name === 'payments')).toMatchObject({ state: 'traced', source: 'rule' });

    lambda.on(GetFunctionConfigurationCommand).resolves({ FunctionName: 'orders', FunctionArn: fnArn('orders'), Runtime: 'nodejs22.x', RevisionId: 'r4' });
    expect(await put({ mode: 'rules' })).toMatchObject({ function: { state: 'traced', source: 'rule', manual: null } });
    expect((await app.request(`${W}/functions/${ACCOUNT_ID}/eu-west-1/orders`, json({ mode: 'off' }, 'PUT'))).status).toBe(400);
    expect((await app.request(`${W}/functions/000000000000/eu-west-1/orders`, json({ mode: 'exclude' }, 'PUT'))).status).toBe(404);
  });

  it('traces selected functions in bulk', async () => {
    const a = await connected();
    const res = await app.request(
      `${W}/functions/bulk`,
      json({ mode: 'trace', functions: ['orders', 'stage-orders'].map((name) => ({ account_id: ACCOUNT_ID, region: 'eu-west-1', name })) }),
    );
    expect(res.status).toBe(202);
    await settle(a.id);
    const states = Object.fromEntries((await req(`${W}/functions`)).items.map((f: any) => [f.name, f.state]));
    expect(states).toEqual({ orders: 'traced', payments: 'available', 'stage-orders': 'traced', legacy: 'unsupported' });
  });

  it('updates regions and deletes with detach', async () => {
    const a = await connected();
    const patched = await req(`${W}/accounts/${a.id}`, json({ regions: ['eu-west-1', 'us-east-1'] }, 'PATCH'));
    expect(patched.regions).toEqual(['eu-west-1', 'us-east-1']);
    await settle(a.id);

    const res = await req(`${W}/accounts/${a.id}`, { method: 'DELETE' });
    expect(res).toMatchObject({ deleted: true, detached: true });
    expect((await req(`${W}/accounts`)).items).toEqual([]);
    expect((await req(`${W}/functions`)).items).toEqual([]);
    expect((await app.request(`${W}/accounts/${a.id}`)).status).toBe(404);
  });

  it('accepts EventBridge events only with the connection secret', async () => {
    const a = await connected();
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
