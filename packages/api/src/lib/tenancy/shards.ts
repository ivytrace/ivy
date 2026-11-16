/**
 * Cells: each shard is its own ClickHouse. `IVY_SHARDS` maps shard IDs to their endpoints, e.g.
 *   {"shard-1": {"clickhouse": "http://clickhouse:8123"}}
 * Without it there is one shard, `shard-1`, at IVY_CLICKHOUSE_URL. Ingest (packages/ingest) reads the same map.
 */
export const DEFAULT_SHARD = 'shard-1';

export interface ShardConfig {
  clickhouse: string;
}

const env = (name: string) => process.env[name]?.trim() || undefined;

export function parseShards(raw: string | undefined): Map<string, ShardConfig> {
  if (!raw) {
    return new Map([
      [
        DEFAULT_SHARD,
        { clickhouse: env('IVY_CLICKHOUSE_URL') ?? 'http://localhost:8123' },
      ],
    ]);
  }
  const parsed = JSON.parse(raw) as Record<string, Partial<ShardConfig>>;
  const shards = new Map<string, ShardConfig>();
  for (const [id, cfg] of Object.entries(parsed)) {
    if (!cfg?.clickhouse) throw new Error(`IVY_SHARDS: shard ${id} needs a "clickhouse" URL`);
    shards.set(id, { clickhouse: cfg.clickhouse.replace(/\/$/, '') });
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
