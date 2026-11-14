import { createClient } from '@clickhouse/client';

export const clickhouse = createClient({
  url: process.env.IVY_CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.IVY_CLICKHOUSE_USER ?? 'ivy',
  password: process.env.IVY_CLICKHOUSE_PASSWORD ?? 'ivy',
  database: process.env.IVY_CLICKHOUSE_DATABASE ?? 'ivy',
  clickhouse_settings: {
    output_format_json_quote_64bit_integers: 0,
    max_execution_time: 30,
  },
});

export async function query<T>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const result = await clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' });
  return result.json<T>();
}
