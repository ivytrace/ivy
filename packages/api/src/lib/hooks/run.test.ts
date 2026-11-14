import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace } from '../tenancy/workspaces.js';
import { resetTenancyForTests } from '../tenancy/testing.js';
import { callProvider, findHook, hookEnv, hookStats, notify, parseProviderOutput, resetHookStatsForTests } from './run.js';

const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ivy-hooks-')));
const out = path.join(dir, 'out');

function hook(name: string, body: string, mode = 0o755) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, mode);
}

const data = {
  workspace: { id: 'ten_a', slug: 'acme', name: 'Acme' },
  connection: { id: 'c1', account_id: '123456789012', stack_name: 's', stack_region: 'eu-west-1' },
  template: 'AWSTemplateFormatVersion: 2010-09-09',
};

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  vi.stubEnv('IVY_HOOKS_DIR', dir);
  vi.stubEnv('HOOK_OUT', out);
  resetHookStatsForTests();
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('finding hooks', () => {
  it('needs an executable regular file or symlink directly in the directory', async () => {
    expect(await findHook('publish-cfn-template')).toBeNull();
    hook('publish-cfn-template', 'exit 0', 0o644);
    expect(await findHook('publish-cfn-template')).toBeNull();
    expect(await callProvider('publish-cfn-template', data)).toEqual({ status: 'absent' });
    chmodSync(path.join(dir, 'publish-cfn-template'), 0o755);
    expect(await findHook('publish-cfn-template')).toBe(path.join(dir, 'publish-cfn-template'));
    hook('target', 'exit 0');
    symlinkSync(path.join(dir, 'target'), path.join(dir, 'on-member-joined'));
    expect(await findHook('on-member-joined')).toBe(path.join(dir, 'on-member-joined'));
    for (const bad of ['../etc/passwd', 'a/b', '.hidden', 'UPPER', '']) expect(await findHook(bad)).toBeNull();
  });
});

describe('provider hooks', () => {
  it('pass the envelope on stdin, run in the hooks directory, and return the result', async () => {
    hook('publish-cfn-template', `cat > "$HOOK_OUT"; printf '{"version":1,"result":{"url":"https://b.s3.amazonaws.com/t","cwd":"%s"}}' "$(pwd)"`);
    vi.stubEnv('IVY_PUBLIC_URL', 'https://ivy.example.com');
    const res = await callProvider('publish-cfn-template', data);
    expect(res).toEqual({ status: 'ok', result: { url: 'https://b.s3.amazonaws.com/t', cwd: dir } });
    const event = JSON.parse(readFileSync(out, 'utf8'));
    expect(event).toMatchObject({ version: 1, hook: 'publish-cfn-template', instance: 'https://ivy.example.com', data });
    expect(event.id).toMatch(/^hk_[0-9A-Za-z]{21}$/);
    expect(Date.parse(event.timestamp)).toBeGreaterThan(0);
    expect(hookStats()).toEqual({ 'publish-cfn-template': { runs: 1, ok: 1, failed: 0 } });
  });

  it('accept a bare result object, and treat anything else as failure', () => {
    expect(parseProviderOutput('{"url":"x"}')).toEqual({ ok: true, result: { url: 'x' } });
    expect(parseProviderOutput('{"version":1,"result":{"url":"x"}}')).toEqual({ ok: true, result: { url: 'x' } });
    for (const bad of ['', 'nope', '[]', '"x"', 'null', '{"version":2,"result":{}}', '{"version":1}', '{"result":"x"}']) {
      expect(parseProviderOutput(bad)).toEqual({ ok: false });
    }
  });

  it('fail on a non-zero exit, bad output and timeouts (killing the process group)', async () => {
    hook('publish-cfn-template', 'echo oops >&2; exit 3');
    expect(await callProvider('publish-cfn-template', data)).toEqual({ status: 'failed', error: 'exited with code 3' });
    hook('publish-cfn-template', 'echo not json');
    expect((await callProvider('publish-cfn-template', data)).status).toBe('failed');
    hook('publish-cfn-template', `(sleep 3; touch "$HOOK_OUT") & sleep 5`);
    const started = Date.now();
    expect(await callProvider('publish-cfn-template', data, { timeoutMs: 300 })).toEqual({ status: 'failed', error: 'timed out after 300 ms' });
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 3500));
    expect(existsSync(out)).toBe(false);
    expect(hookStats()['publish-cfn-template']).toEqual({ runs: 3, ok: 0, failed: 3 });
  }, 10_000);

  it('get only the allow-listed environment', async () => {
    vi.stubEnv('IVY_SECRET_KEY', 'secret');
    vi.stubEnv('IVY_COLLECTOR_TOKEN', 'secret');
    vi.stubEnv('IVY_INTERNAL_API_TOKEN', 'secret');
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    vi.stubEnv('HOOK_BUCKET', 'b');
    hook('publish-cfn-template', `printf '{"names":"%s"}' "$(env | cut -d= -f1 | sort | tr '\\n' ' ')"`);
    const res = await callProvider('publish-cfn-template', data);
    const names = res.status === 'ok' ? String((res.result as Record<string, unknown>).names).trim().split(' ') : [];
    expect(names).toEqual(expect.arrayContaining(['AWS_REGION', 'HOOK_BUCKET', 'HOOK_OUT', 'IVY_HOOKS_DIR', 'PATH']));
    expect(names.filter((n) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(n)).every((n) => /^(PATH|HOME|IVY_HOOKS_DIR|IVY_PUBLIC_URL|AWS_.*|HOOK_.*)$/.test(n))).toBe(true);
    expect(hookEnv({ IVY_SECRET_KEY: 'x', PATH: '/bin', AWS_PROFILE: 'p', IVY_CLICKHOUSE_URL: 'u' })).toEqual({ PATH: '/bin', AWS_PROFILE: 'p' });
  });
});

describe('notification hooks', () => {
  it('run after the caller has moved on, and never throw', async () => {
    hook('on-workspace-created', `cat > "$HOOK_OUT"`);
    const run = notify('on-workspace-created', { workspace: data.workspace, owner: { sub: 'idn_a', email: 'a@example.com' } });
    expect(existsSync(out)).toBe(false);
    await run;
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ hook: 'on-workspace-created', data: { owner: { sub: 'idn_a' } } });

    hook('on-member-joined', 'exit 1');
    await expect(
      notify('on-member-joined', { workspace: data.workspace, member: { sub: 's', email: null, role: 'member' }, invitation_id: 'inv_1', invited_by: null }),
    ).resolves.toBeUndefined();
    expect(hookStats()['on-member-joined']).toEqual({ runs: 1, ok: 0, failed: 1 });
  });

  it('fire on-workspace-created when a workspace is created', async () => {
    await resetTenancyForTests();
    hook('on-workspace-created', `cat > "$HOOK_OUT"`);
    const ws = await createWorkspace({ sub: 'idn_o', issuer: 'x', email: 'o@example.com', clientId: 'ivy', agent: null }, { name: 'Acme', slug: 'acme' });
    const read = () => (existsSync(out) ? readFileSync(out, 'utf8') : '');
    for (let i = 0; i < 100 && !read().endsWith('}'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(read()).data).toEqual({ workspace: { id: ws.id, slug: 'acme', name: 'Acme' }, owner: { sub: 'idn_o', email: 'o@example.com' } });
  });
});
