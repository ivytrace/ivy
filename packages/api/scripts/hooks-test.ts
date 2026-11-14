/**
 * Runs one hook from IVY_HOOKS_DIR with a sample (or your own) `data` payload, the way the API would,
 * and prints the outcome. See docs/implementation/hooks.md.
 *
 *   pnpm --filter @ivy/api hooks:test <name> [data.json]
 *   IVY_HOOKS_DIR=deploy/hooks.example pnpm --filter @ivy/api hooks:test on-workspace-created
 *   docker compose -f deploy/docker-compose.yml exec api node hooks-test.mjs publish-cfn-template
 */
import { readFileSync } from 'node:fs';
import { findHook, hooksDir, runHookForTest } from '../src/lib/hooks/run.js';
import type { HookName, NotificationHooks, ProviderHooks } from '../src/lib/hooks/types.js';

const workspace = { id: 'ten_SampleWorkspaceId00001', slug: 'acme', name: 'Acme' };
const owner = { sub: 'idn_sample', email: 'owner@example.com' };

const SAMPLES: { [N in keyof ProviderHooks]: ProviderHooks[N]['data'] } & NotificationHooks = {
  'publish-cfn-template': {
    workspace,
    connection: { id: '7695fb70-0000-4000-8000-000000000000', account_id: '123456789012', stack_name: 'ivy-trace-7695fb70', stack_region: 'eu-west-1' },
    template: "AWSTemplateFormatVersion: '2010-09-09'\nDescription: sample\nResources: {}\n",
  },
  'on-workspace-created': { workspace, owner },
  'on-member-joined': { workspace, member: { sub: 'idn_member', email: 'member@example.com', role: 'member' }, invitation_id: 'inv_sample', invited_by: owner },
  'on-aws-account-connected': {
    workspace,
    connection: { id: '7695fb70-0000-4000-8000-000000000000', name: 'Production', account_id: '123456789012', stack_region: 'eu-west-1', regions: ['eu-west-1'], all_regions: false },
  },
};

const [name, file] = process.argv.slice(2).filter((a) => a !== '--');
if (!name || !(name in SAMPLES)) {
  console.log(`Usage: hooks:test <${Object.keys(SAMPLES).join(' | ')}> [data.json]`);
  process.exit(name ? 1 : 0);
}
if (!(await findHook(name))) {
  console.error(`No executable ${name} in ${hooksDir()} (set IVY_HOOKS_DIR)`);
  process.exit(1);
}
const data = file ? JSON.parse(readFileSync(file, 'utf8')) : SAMPLES[name as keyof typeof SAMPLES];
const outcome = await runHookForTest(name as HookName, data, !name.startsWith('on-'));
console.log(JSON.stringify(outcome, null, 2));
process.exit(outcome.status === 'ok' ? 0 : 1);
