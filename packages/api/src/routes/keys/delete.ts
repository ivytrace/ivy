import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { projectOf, tenantOf } from '../../lib/tenancy/context.js';
import { tenancyStore } from '../../lib/tenancy/store.js';
import { keyProjectId, revokeApiKey } from '../../lib/tenancy/tenants.js';
import { presentKey } from './get.js';

/**
 * Revokes a key of the project (ingest with it stops within a minute). Revoking the auto-trace key
 * makes the next sync mint a new one and rewrite the project's functions.
 */
export async function deleteKey(c: Context) {
  const tenant = tenantOf(c).id;
  const key = (await tenancyStore().listKeys(tenant)).find((k) => k.id === c.req.param('id') && keyProjectId(k) === projectOf(c).id);
  if (!key) throw new HTTPException(404, { message: 'Key not found' });
  if (key.kind === 'bootstrap') throw new HTTPException(409, { message: 'This key comes from IVY_INGEST_API_KEY; change or unset the variable instead' });
  return c.json(presentKey(await revokeApiKey(tenant, key.id)));
}
