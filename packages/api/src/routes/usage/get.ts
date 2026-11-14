import type { Context } from 'hono';
import { workspaceUsage } from '../../lib/limits/present.js';
import { monthOf } from '../../lib/limits/usage.js';
import { tenantOf } from '../../lib/tenancy/context.js';

/** This month's traces and the limits of the caller's workspace. */
export async function getUsage(c: Context) {
  const now = Date.now();
  return c.json(await workspaceUsage(tenantOf(c), monthOf(now), now));
}
