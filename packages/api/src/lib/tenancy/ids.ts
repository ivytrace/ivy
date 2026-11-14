import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniform random base62 string (rejection sampling, no modulo bias). */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out += ALPHABET[byte % 62];
    }
  }
  return out;
}

export const newTenantId = () => `ten_${randomBase62(21)}`;
export const newProjectId = () => `prj_${randomBase62(21)}`;
export const newInvitationId = () => `inv_${randomBase62(21)}`;
export const newKeyId = () => `key_${randomBase62(21)}`;

/** API keys: `ivy_` + 40 base62 characters (~238 bits). */
export const newApiKey = () => `ivy_${randomBase62(40)}`;

export const hashKey = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');

/** What the UI/CLI shows to identify a key: `ivy_` and the first 6 random characters. */
export const keyPrefix = (key: string) => key.slice(0, key.startsWith('ivy_') ? 10 : 4);

/**
 * The ID of a workspace's default project, derived from the tenant ID so that every process (and
 * the schema migration in deploy/clickhouse/init.sh, which computes the same in SQL) agrees on it
 * without a lookup: `prj_` + the first 21 hex characters of sha256('ivy-default-project:' + tenant).
 */
export const defaultProjectId = (tenantId: string) =>
  `prj_${createHash('sha256').update(`ivy-default-project:${tenantId}`, 'utf8').digest('hex').slice(0, 21)}`;

/**
 * The project a workspace currently designates as its default: where keys without a project and
 * auto-traced functions without a project go. Movable (`tenants.default_project_id`); rows that
 * never set it fall back to the derived ID above.
 */
export const workspaceDefaultProject = (tenant: { id: string; default_project_id?: string }) =>
  tenant.default_project_id || defaultProjectId(tenant.id);
