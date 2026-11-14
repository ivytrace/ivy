import type { Context } from 'hono';
import { projectOf, tenantOf } from '../../lib/tenancy/context.js';
import { defaultProjectOf } from '../../lib/tenancy/projects.js';
import type { ApiKeyRecord } from '../../lib/tenancy/store.js';
import { keyProjectId } from '../../lib/tenancy/tenants.js';
import { tenancyStore } from '../../lib/tenancy/store.js';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export const presentKey = (k: ApiKeyRecord) => ({
  id: k.id,
  name: k.name,
  kind: k.kind,
  prefix: k.prefix,
  created_at: iso(k.created_at),
  revoked_at: iso(k.revoked_at),
});

/** The project's ingest keys (prefix only; the key itself is shown once at creation). `?revoked=1` includes revoked ones. */
export async function getKeys(c: Context) {
  const project = projectOf(c);
  const revoked = c.req.query('revoked') === '1';
  const defaultId = await defaultProjectOf(tenantOf(c).id);
  const keys = (await tenancyStore().listKeys(tenantOf(c).id)).filter((k) => keyProjectId(k, defaultId) === project.id && (revoked || k.revoked_at === null));
  return c.json({ items: keys.map(presentKey) });
}
