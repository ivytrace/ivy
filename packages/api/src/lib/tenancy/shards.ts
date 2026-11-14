/**
 * Cells: each shard is a full copy of the data stack (collector + ClickHouse). `IVY_SHARDS` maps
 * shard IDs to their endpoints, e.g.
 *   {"shard-1": {"clickhouse": "http://clickhouse:8123", "collector": "http://collector:4318"}}
 * Without it there is one shard, `shard-1`, built from IVY_CLICKHOUSE_URL and IVY_COLLECTOR_URL.
 */
export const DEFAULT_SHARD = 'shard-1';

export interface ShardConfig {
  clickhouse: string;
  collector: string;
}

const env = (name: string) => process.env[name]?.trim() || undefined;

export function parseShards(raw: string | undefined): Map<string, ShardConfig> {
  if (!raw) {
    return new Map([
      [
        DEFAULT_SHARD,
        {
          clickhouse: env('IVY_CLICKHOUSE_URL') ?? 'http://localhost:8123',
          collector: env('IVY_COLLECTOR_URL') ?? 'http://localhost:4319',
        },
      ],
    ]);
  }
  const parsed = JSON.parse(raw) as Record<string, Partial<ShardConfig>>;
  const shards = new Map<string, ShardConfig>();
  for (const [id, cfg] of Object.entries(parsed)) {
    if (!cfg?.clickhouse || !cfg?.collector) throw new Error(`IVY_SHARDS: shard ${id} needs "clickhouse" and "collector" URLs`);
    shards.set(id, { clickhouse: cfg.clickhouse.replace(/\/$/, ''), collector: cfg.collector.replace(/\/$/, '') });
  }
  if (!shards.size) throw new Error('IVY_SHARDS has no shards');
  return shards;
}

let shards: Map<string, ShardConfig> | undefined;

export function shardConfigs(): Map<string, ShardConfig> {
  shards ??= parseShards(env('IVY_SHARDS'));
  return shards;
}

export function shardConfig(id: string): ShardConfig {
  const cfg = shardConfigs().get(id);
  if (!cfg) throw new Error(`Unknown shard ${id}`);
  return cfg;
}
