import type { Context } from 'hono';
import { controlClient, shardClient } from '../../lib/clickhouse/client.js';
import { shardConfigs } from '../../lib/tenancy/shards.js';

export async function getHealth(c: Context) {
  const pings = await Promise.all([controlClient(), ...[...shardConfigs().keys()].map(shardClient)].map((client) => client.ping()));
  const ok = pings.every((p) => p.success);
  return c.json({ ok, clickhouse: ok }, ok ? 200 : 503);
}
