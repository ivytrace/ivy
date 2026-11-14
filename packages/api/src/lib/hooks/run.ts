import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomBase62 } from '../tenancy/ids.js';
import {
  HOOK_VERSION,
  type HookEnvelope,
  type HookName,
  type NotificationHookName,
  type NotificationHooks,
  type ProviderHookName,
  type ProviderHooks,
} from './types.js';

/** Executable hooks for rare control-plane events (docs/implementation/hooks.md). Never on ingest, query or quota paths. */

export type HookOutcome<R = unknown> =
  | { status: 'absent' }
  | { status: 'ok'; result: R }
  | { status: 'failed'; error: string };

export const PROVIDER_TIMEOUT_MS = 10_000;
export const NOTIFICATION_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const env = (name: string) => process.env[name]?.trim() || undefined;

export const hooksDir = () => path.resolve(env('IVY_HOOKS_DIR') ?? '/etc/ivy/hooks');

/**
 * The hook's environment: only `PATH`, `HOME`, `IVY_HOOKS_DIR`, `IVY_PUBLIC_URL`, and every `AWS_*`
 * and `HOOK_*` variable of the API process. Nothing else (in particular no Ivy secrets).
 */
export function hookEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = (k: string) => ['PATH', 'HOME', 'IVY_HOOKS_DIR', 'IVY_PUBLIC_URL'].includes(k) || k.startsWith('AWS_') || k.startsWith('HOOK_');
  return Object.fromEntries(Object.entries(source).filter(([k, v]) => v !== undefined && allowed(k)));
}

/**
 * The hook's path when `<IVY_HOOKS_DIR>/<name>` is an executable regular file, or a symlink to one,
 * directly inside the directory. Looked up on every call, so adding a hook needs no restart.
 */
export async function findHook(name: string): Promise<string | null> {
  if (!NAME.test(name)) return null;
  const dir = hooksDir();
  const file = path.join(dir, name);
  if (path.dirname(file) !== dir) return null;
  try {
    const entry = await lstat(file);
    if (!entry.isFile() && !entry.isSymbolicLink()) return null;
    if (!(await stat(file)).isFile()) return null;
    await access(file, constants.X_OK);
    return file;
  } catch {
    return null;
  }
}

export interface HookStats {
  runs: number;
  ok: number;
  failed: number;
}
const stats = new Map<string, HookStats>();

/** Runs per hook since the process started (served on the API's internal /stats). */
export const hookStats = () => Object.fromEntries([...stats].map(([k, v]) => [k, { ...v }]));

function count(name: string, ok: boolean) {
  const s = stats.get(name) ?? { runs: 0, ok: 0, failed: 0 };
  s.runs++;
  if (ok) s.ok++;
  else s.failed++;
  stats.set(name, s);
}

export function envelope<D>(hook: HookName, data: D): HookEnvelope<D> {
  return {
    version: HOOK_VERSION,
    hook,
    id: `hk_${randomBase62(21)}`,
    timestamp: new Date().toISOString(),
    instance: env('IVY_PUBLIC_URL') ?? hostname(),
    data,
  };
}

/** A provider's stdout: `{ "version": 1, "result": {…} }`, or a bare result object. */
export function parseProviderOutput(stdout: string): { ok: true; result: Record<string, unknown> } | { ok: false } {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { ok: false };
  }
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(value)) return { ok: false };
  if ('version' in value || 'result' in value) {
    return value.version === HOOK_VERSION && isObject(value.result) ? { ok: true, result: value.result } : { ok: false };
  }
  return { ok: true, result: value };
}

interface Exec {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  timedOut: boolean;
  tooMuchOutput: boolean;
}

/** Runs the file with the envelope on stdin, in its own process group so a timeout kills everything it started. */
function exec(file: string, event: HookEnvelope, timeoutMs: number): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn(file, [], { cwd: hooksDir(), env: hookEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let errText = '';
    let timedOut = false;
    let tooMuchOutput = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        tooMuchOutput = true;
        killGroup();
      } else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes < MAX_STDERR_BYTES) errText += chunk.toString('utf8');
      errBytes += chunk.length;
    });
    child.on('error', () => {});
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      for (const line of errText.split('\n').filter(Boolean)) console.log(`[hook ${event.hook} ${event.id}] ${line}`);
      resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), timedOut, tooMuchOutput });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event));
  });
}

async function run(name: HookName, data: unknown, timeoutMs: number, provider: boolean): Promise<HookOutcome<Record<string, unknown>>> {
  const file = await findHook(name);
  if (!file) return { status: 'absent' };
  const event = envelope(name, data);
  const started = Date.now();
  let outcome: HookOutcome<Record<string, unknown>>;
  try {
    const r = await exec(file, event, timeoutMs);
    if (r.timedOut) outcome = { status: 'failed', error: `timed out after ${timeoutMs} ms` };
    else if (r.tooMuchOutput) outcome = { status: 'failed', error: `printed more than ${MAX_STDOUT_BYTES} bytes` };
    else if (r.code !== 0) outcome = { status: 'failed', error: r.code === null ? `was killed (${r.signal})` : `exited with code ${r.code}` };
    else if (!provider) outcome = { status: 'ok', result: {} };
    else {
      const parsed = parseProviderOutput(r.stdout);
      outcome = parsed.ok ? { status: 'ok', result: parsed.result } : { status: 'failed', error: 'printed no valid result (expected {"version":1,"result":{…}})' };
    }
  } catch (err) {
    outcome = { status: 'failed', error: (err as Error).message };
  }
  count(name, outcome.status === 'ok');
  const took = Date.now() - started;
  console.log(`[hook ${name} ${event.id}] ${outcome.status === 'ok' ? 'ok' : `failed: ${outcome.error}`} (${took} ms)`);
  return outcome;
}

/**
 * Calls a provider hook and waits for its result. `absent` and `failed` mean: use the built-in
 * fallback. A result is only shape-checked as an object; callers validate the fields they use.
 */
export function callProvider<N extends ProviderHookName>(
  name: N,
  data: ProviderHooks[N]['data'],
  options: { timeoutMs?: number } = {},
): Promise<HookOutcome<Partial<ProviderHooks[N]['result']>>> {
  return run(name, data, options.timeoutMs ?? PROVIDER_TIMEOUT_MS, true) as Promise<HookOutcome<Partial<ProviderHooks[N]['result']>>>;
}

/**
 * Fires a notification hook after the action has committed: runs in the background, at most once,
 * and never throws or delays the caller. The returned promise is only for tests.
 */
export function notify<N extends NotificationHookName>(name: N, data: NotificationHooks[N], options: { timeoutMs?: number } = {}): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => run(name, data, options.timeoutMs ?? NOTIFICATION_TIMEOUT_MS, false))
    .then(
      () => undefined,
      (err) => console.error(`[hook ${name}] ${(err as Error).message}`),
    );
}

/** Runs any hook once and returns its raw outcome (the `hooks:test` CLI). */
export const runHookForTest = (name: HookName, data: unknown, provider: boolean) =>
  run(name, data, provider ? PROVIDER_TIMEOUT_MS : NOTIFICATION_TIMEOUT_MS, provider);

export function resetHookStatsForTests() {
  stats.clear();
}
