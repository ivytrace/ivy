/**
 * Tenant and API key admin (until there is an admin UI). Talks to the control database directly.
 *
 *   pnpm --filter @ivy/api tenants list
 *   pnpm --filter @ivy/api tenants create "Acme" [--shard shard-1]
 *   pnpm --filter @ivy/api tenants keys <tenant>
 *   pnpm --filter @ivy/api tenants projects <tenant>
 *   pnpm --filter @ivy/api tenants create-key <tenant> [name] [--project <slug or id>]
 *   pnpm --filter @ivy/api tenants revoke-key <tenant> <key id>
 *   pnpm --filter @ivy/api tenants set-shard <tenant> <shard>
 *
 * In Docker: docker compose -f deploy/docker-compose.yml exec api node tenants.mjs list
 */
import { defaultProjectId } from '../src/lib/tenancy/ids.js';
import { findProject } from '../src/lib/tenancy/projects.js';
import { tenancyStore } from '../src/lib/tenancy/store.js';
import { createApiKey, createTenant, revokeApiKey, setTenantShard } from '../src/lib/tenancy/tenants.js';

const [command, ...rest] = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest.splice(i, 2)[1] : undefined;
};
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '-');

async function main() {
  switch (command) {
    case 'list': {
      for (const t of await tenancyStore().listTenants()) console.log(`${t.id}\t${t.slug}\t${t.shard_id}\t${iso(t.created_at)}\t${t.name}`);
      return;
    }
    case 'create': {
      const shard = flag('shard');
      const name = rest.join(' ');
      if (!name) throw new Error('Usage: create <name> [--shard <id>]');
      const tenant = await createTenant(name, shard);
      const { key, record } = await createApiKey(tenant.id, defaultProjectId(tenant.id), 'Default key');
      console.log(`tenant  ${tenant.id} (${tenant.shard_id}), slug ${tenant.slug}, default project ${defaultProjectId(tenant.id)}`);
      console.log(`key     ${record.id}`);
      console.log(`api key ${key}   (shown once; store it now)`);
      return;
    }
    case 'keys': {
      for (const k of await tenancyStore().listKeys(required(0, 'tenant'))) {
        console.log(`${k.id}\t${k.project_id || 'default'}\t${k.kind}\t${k.prefix}…\tcreated ${iso(k.created_at)}\trevoked ${iso(k.revoked_at)}\t${k.name}`);
      }
      return;
    }
    case 'projects': {
      for (const p of await tenancyStore().listProjects(required(0, 'tenant'))) {
        console.log(`${p.id}\t${p.slug}\t${p.archived ? 'archived' : 'active'}\t${p.name}`);
      }
      return;
    }
    case 'create-key': {
      const projectRef = flag('project');
      const tenantId = required(0, 'tenant');
      const project = projectRef ? await findProject(tenantId, projectRef) : null;
      if (projectRef && !project) throw new Error(`Unknown project ${projectRef}`);
      const { key, record } = await createApiKey(tenantId, project?.id ?? defaultProjectId(tenantId), rest.slice(1).join(' ') || 'API key');
      console.log(`key     ${record.id}`);
      console.log(`api key ${key}   (shown once; store it now)`);
      return;
    }
    case 'revoke-key': {
      const record = await revokeApiKey(required(0, 'tenant'), required(1, 'key id'));
      console.log(`revoked ${record.id} (${record.prefix}…); the ingest router stops accepting it within a minute`);
      return;
    }
    case 'set-shard': {
      const tenant = await setTenantShard(required(0, 'tenant'), required(1, 'shard'));
      console.log(`${tenant.id} → ${tenant.shard_id}`);
      return;
    }
    default:
      console.log('Commands: list | create <name> [--shard <id>] | keys <tenant> | projects <tenant> | create-key <tenant> [name] [--project <p>] | revoke-key <tenant> <key id> | set-shard <tenant> <shard>');
      process.exitCode = command ? 1 : 0;
  }
}

function required(i: number, what: string): string {
  if (!rest[i]) throw new Error(`Missing ${what}`);
  return rest[i];
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
