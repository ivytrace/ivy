import type { Context } from 'hono';
import { clickhouse } from '../../lib/clickhouse/client.js';

export async function getHealth(c: Context) {
  const ping = await clickhouse.ping();
  return c.json({ ok: ping.success, clickhouse: ping.success }, ping.success ? 200 : 503);
}
