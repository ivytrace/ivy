import type { Context } from 'hono';
import { effectiveLimits, InvalidLimitsError, parseLimits } from '../../../lib/limits/limits.js';
import { limitsStore } from '../../../lib/limits/store.js';
import { badRequest } from '../../../lib/utils/http-error.js';
import { findWorkspace } from '../workspaces/get.js';

/** `PUT /internal/workspaces/:id/limits`: sets the workspace's own limits. */
export async function putInternalLimits(c: Context) {
  const tenant = await findWorkspace(c);
  let limits;
  try {
    limits = parseLimits(await c.req.json().catch(() => null));
  } catch (err) {
    if (err instanceof InvalidLimitsError) throw badRequest(err.message);
    throw err;
  }
  const saved = await limitsStore().save(tenant.id, limits);
  return c.json({ workspace: tenant.id, limits: effectiveLimits(saved), updated_at: new Date(saved.updated_at).toISOString() });
}

/** `DELETE /internal/workspaces/:id/limits`: drops the row: unlimited again. */
export async function deleteInternalLimits(c: Context) {
  const tenant = await findWorkspace(c);
  await limitsStore().remove(tenant.id);
  return c.json({ workspace: tenant.id, limits: effectiveLimits(null) });
}
