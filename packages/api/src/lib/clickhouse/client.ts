import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { shardConfig } from '../tenancy/shards.js';

const env = (name: string) => process.env[name]?.trim() || undefined;

function makeClient(url: string, database: string): ClickHouseClient {
  return createClient({
    url,
    username: env('IVY_CLICKHOUSE_USER') ?? 'ivy',
    password: env('IVY_CLICKHOUSE_PASSWORD') ?? 'ivy',
    database,
    clickhouse_settings: {
      output_format_json_quote_64bit_integers: 0,
      max_execution_time: 30,
    },
  });
}

let control: ClickHouseClient | undefined;
const shards = new Map<string, ClickHouseClient>();

/** The control plane (tenants, API keys, auto-trace config): one database for all cells. */
export function controlClient(): ClickHouseClient {
  control ??= makeClient(
    env('IVY_CONTROL_CLICKHOUSE_URL') ?? shardConfig('shard-1').clickhouse,
    env('IVY_CONTROL_CLICKHOUSE_DATABASE') ?? 'ivy_control',
  );
  return control;
}

/** Span data of the tenants on one shard (cell). */
export function shardClient(shardId: string): ClickHouseClient {
  let client = shards.get(shardId);
  if (!client) {
    client = makeClient(shardConfig(shardId).clickhouse, env('IVY_CLICKHOUSE_DATABASE') ?? 'ivy');
    shards.set(shardId, client);
  }
  return client;
}

export function setClientsForTests(clients: { control?: ClickHouseClient; shard?: ClickHouseClient } | undefined) {
  control = clients?.control;
  shards.clear();
  if (clients?.shard) shards.set('shard-1', clients.shard);
}
