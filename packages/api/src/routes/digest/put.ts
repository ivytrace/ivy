import type { Context } from 'hono';
import { jsonBody } from '../../lib/aws/requests.js';
import { alertStore } from '../../lib/alerts/store.js';
import { membershipOf, requireOwner } from '../../lib/tenancy/context.js';
import { badRequest } from '../../lib/utils/http-error.js';

/** Owners switch the workspace's weekly digest on or off: `{ "enabled": bool }`. */
export async function putDigest(c: Context) {
  requireOwner(c);
  const body = await jsonBody(c);
  if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be a boolean');
  await alertStore().setDigestEnabled(membershipOf(c).workspace.id, body.enabled);
  return c.json({ enabled: body.enabled });
}
