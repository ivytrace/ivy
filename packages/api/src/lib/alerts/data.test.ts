import type { ClickHouseClient } from '@clickhouse/client';
import { afterAll, describe, expect, it } from 'vitest';
import { setClientsForTests } from '../clickhouse/client.js';
import { PROJECT_SETTING, TENANT_SETTING } from '../clickhouse/scoped.js';
import { clickhouseAlertData } from './data.js';

interface Captured {
  query: string;
  query_params: Record<string, unknown>;
  clickhouse_settings: Record<string, unknown>;
}

const captured: Captured[] = [];
setClientsForTests({
  shard: {
    query: async (params: Captured) => {
      captured.push(params);
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient,
});
afterAll(() => setClientsForTests(undefined));

const tenant = { id: 'ten_a', shardId: 'shard-1' };

describe('alert queries', () => {
  it('bind the tenant and project (evaluator, stack line) or explicitly all projects (digest)', async () => {
    await clickhouseAlertData.activeGroups({ tenant, projectId: 'prj_a' }, { since: 1, notified: new Map([['fp', 2]]), throttles: true });
    await clickhouseAlertData.stackLine({ tenant, projectId: 'prj_a' }, '673f1a2b0000000000000000000000aa', Date.now());
    expect(captured).toHaveLength(3);
    for (const q of captured) {
      expect(q.query_params).toMatchObject({ tenant: 'ten_a', project: 'prj_a' });
      expect(q.clickhouse_settings).toMatchObject({ [TENANT_SETTING]: 'ten_a', [PROJECT_SETTING]: 'prj_a' });
    }
    expect(captured[0].query_params).toMatchObject({ notified_fps: ['fp'], notified_at: [2] });

    captured.length = 0;
    await clickhouseAlertData.digest({ tenant, projectId: null }, { from: 0, to: 1 });
    expect(captured).toHaveLength(4);
    for (const q of captured) {
      expect(q.query_params.tenant).toBe('ten_a');
      expect(q.query_params.project).toBeUndefined();
    }
  });
});
