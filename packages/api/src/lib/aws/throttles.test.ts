import { defaultProjectId } from '../tenancy/ids.js';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAwsClientsForTests } from './clients.js';
import { pollAccountThrottles, pollWindow, setThrottleSinkForTests, throttlePollDue, type ThrottleRow } from './throttles.js';
import type { AwsAccount, FunctionStatus } from './types.js';

const cw = mockClient(CloudWatchClient);
const sts = mockClient(STSClient);

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 14, 12, 0, 30);
const NOW_MINUTE = Date.UTC(2026, 10, 14, 12, 0);

const account: AwsAccount = {
  tenant_id: 'ten_a',
  id: 'conn-1',
  name: 'Prod',
  account_id: '123456789012',
  role_arn: 'arn:aws:iam::123456789012:role/IvyTrace-abc',
  external_id: 'ivy-ext',
  event_secret: 'secret',
  stack_name: 'ivy-trace-abc',
  stack_region: 'eu-west-1',
  regions: ['eu-west-1', 'us-east-1'],
  all_regions: false,
  status: 'connected',
  error: '',
  created_at: 1,
  verified_at: 1,
  last_sync_at: 0,
  default_project_id: '',
  reviewed_at: 0,
  throttle_metrics: true,
  throttle_status: '',
  throttles_polled_to: 0,
};

const fn = (function_name: string, state: FunctionStatus['state'] = 'traced', region = 'eu-west-1'): FunctionStatus => ({
  tenant_id: 'ten_a',
  account_id: account.account_id,
  region,
  function_name,
  function_arn: `arn:aws:lambda:${region}:123456789012:function:${function_name}`,
  runtime: 'nodejs22.x',
  state,
  reason: '',
  project_id: function_name === 'worker' ? 'prj_ops' : '',
  project_source: state === 'traced' ? 'rule' : '',
  rule_id: '',
  stack: '',
  tags: {},
  last_modified: '',
  first_seen_at: 1,
  updated_at: 1,
});

let saved: ThrottleRow[];

beforeEach(() => {
  cw.reset();
  sts.reset();
  resetAwsClientsForTests();
  saved = [];
  setThrottleSinkForTests({ save: async (_tenant, rows) => void saved.push(...rows) });
  sts.on(AssumeRoleCommand).resolves({
    Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'secret', SessionToken: 'token', Expiration: new Date(NOW + 3600_000) },
  });
});

afterEach(() => setThrottleSinkForTests(undefined));

const queries = (i: number) => cw.commandCalls(GetMetricDataCommand)[i].args[0].input;

describe('throttle polling', () => {
  it('is due every 5 minutes unless the account turned it off', () => {
    expect(throttlePollDue(account, NOW)).toBe(true);
    expect(throttlePollDue({ ...account, throttles_polled_to: NOW - 2 * MIN }, NOW)).toBe(false);
    expect(throttlePollDue({ ...account, throttles_polled_to: NOW - 5 * MIN }, NOW)).toBe(true);
    expect(throttlePollDue({ ...account, throttle_metrics: false }, NOW)).toBe(false);
  });

  it('re-reads 10 minutes before the watermark, and at most 3 hours', () => {
    expect(pollWindow({ ...account, throttles_polled_to: NOW_MINUTE - 5 * MIN }, NOW)).toEqual({ from: NOW_MINUTE - 15 * MIN, to: NOW_MINUTE });
    expect(pollWindow(account, NOW)).toEqual({ from: NOW_MINUTE - 180 * MIN, to: NOW_MINUTE });
  });

  it('asks only for the account-level metric when nothing was throttled', async () => {
    cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'account', Timestamps: [], Values: [] }] });
    const result = await pollAccountThrottles(account, account.regions, [fn('checkout'), fn('other', 'traced', 'us-east-1')], NOW);
    expect(result).toEqual({ throttle_status: 'ok', throttles_polled_to: NOW_MINUTE });
    expect(cw.commandCalls(GetMetricDataCommand)).toHaveLength(2); // one per region with traced functions
    const q = queries(0).MetricDataQueries!;
    expect(q).toHaveLength(1);
    expect(q[0].MetricStat).toEqual({
      Metric: { Namespace: 'AWS/Lambda', MetricName: 'Throttles', Dimensions: [] },
      Period: 60,
      Stat: 'Sum',
    });
    expect(saved).toEqual([]);
  });

  it('skips regions without traced functions', async () => {
    cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });
    await pollAccountThrottles(account, account.regions, [fn('checkout'), fn('legacy', 'opted_out', 'us-east-1')], NOW);
    expect(cw.commandCalls(GetMetricDataCommand)).toHaveLength(1);
  });

  it('fetches per-function throttles for traced functions only, for the throttled minutes, under their projects', async () => {
    const t1 = new Date(NOW_MINUTE - 7 * MIN);
    const t2 = new Date(NOW_MINUTE - 4 * MIN);
    cw.on(GetMetricDataCommand)
      .resolvesOnce({ MetricDataResults: [{ Id: 'account', Timestamps: [t2, t1, new Date(NOW_MINUTE - 3 * MIN)], Values: [5, 3, 0] }] })
      .resolvesOnce({
        MetricDataResults: [
          { Id: 'f0', Timestamps: [t1, t2], Values: [3, 4] },
          { Id: 'f1', Timestamps: [t2], Values: [1] },
        ],
      });
    const result = await pollAccountThrottles({ ...account, regions: ['eu-west-1'] }, ['eu-west-1'], [fn('checkout'), fn('worker'), fn('legacy', 'opted_out')], NOW);
    expect(result.throttle_status).toBe('ok');
    const perFunction = queries(1);
    expect(perFunction.StartTime).toEqual(t1);
    expect(perFunction.EndTime).toEqual(new Date(t2.getTime() + MIN));
    expect(perFunction.MetricDataQueries!.map((q) => q.MetricStat!.Metric!.Dimensions)).toEqual([
      [{ Name: 'FunctionName', Value: 'checkout' }],
      [{ Name: 'FunctionName', Value: 'worker' }],
    ]);
    expect(saved).toEqual([
      { tenant_id: 'ten_a', project_id: defaultProjectId('ten_a'), function: 'checkout', region: 'eu-west-1', minute: t1.getTime(), account_id: account.account_id, throttles: 3 },
      { tenant_id: 'ten_a', project_id: defaultProjectId('ten_a'), function: 'checkout', region: 'eu-west-1', minute: t2.getTime(), account_id: account.account_id, throttles: 4 },
      { tenant_id: 'ten_a', project_id: 'prj_ops', function: 'worker', region: 'eu-west-1', minute: t2.getTime(), account_id: account.account_id, throttles: 1 },
    ]);
  });

  it('splits more than 500 functions into several requests and follows NextToken', async () => {
    const names = Array.from({ length: 501 }, (_, i) => `fn-${i}`);
    cw.on(GetMetricDataCommand)
      .resolvesOnce({ MetricDataResults: [{ Id: 'account', Timestamps: [new Date(NOW_MINUTE - MIN)], Values: [2] }] })
      .resolvesOnce({ MetricDataResults: [], NextToken: 'next' })
      .resolvesOnce({ MetricDataResults: [{ Id: 'f499', Timestamps: [new Date(NOW_MINUTE - MIN)], Values: [2] }] })
      .resolvesOnce({ MetricDataResults: [] });
    await pollAccountThrottles(account, ['eu-west-1'], names.map((n) => fn(n)), NOW);
    const calls = cw.commandCalls(GetMetricDataCommand).map((c) => c.args[0].input);
    expect(calls.map((c) => c.MetricDataQueries!.length)).toEqual([1, 500, 500, 1]);
    expect(calls[2].NextToken).toBe('next');
    expect(saved.map((r) => r.function)).toEqual(['fn-499']);
  });

  it('reports a role without cloudwatch:GetMetricData as missing_permission and keeps the watermark', async () => {
    cw.on(GetMetricDataCommand).rejects(
      Object.assign(new Error('User: arn:aws:sts::123456789012:assumed-role/IvyTrace-abc/ivy-trace is not authorized to perform: cloudwatch:GetMetricData'), {
        name: 'AccessDenied',
      }),
    );
    const result = await pollAccountThrottles({ ...account, throttles_polled_to: 42 }, account.regions, [fn('checkout'), fn('b', 'traced', 'us-east-1')], NOW);
    expect(result).toEqual({ throttle_status: 'missing_permission', throttles_polled_to: 42 });
    expect(cw.commandCalls(GetMetricDataCommand)).toHaveLength(1);
  });

  it('reports other errors per region without moving the watermark', async () => {
    cw.on(GetMetricDataCommand).rejects(Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }));
    const result = await pollAccountThrottles(account, ['eu-west-1'], [fn('checkout')], NOW);
    expect(result).toEqual({ throttle_status: 'error', throttles_polled_to: 0, error: 'eu-west-1: Rate exceeded' });
  });
});
