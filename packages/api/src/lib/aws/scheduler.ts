import { syncIntervalMs } from './config.js';
import { awsStore } from './store.js';
import { syncAccount, syncFunction } from './sync.js';
import type { AwsAccount } from './types.js';

const running = new Map<string, Promise<void>>();
/** Regions requested while a sync was running; `null` means all regions. */
const queued = new Map<string, Set<string> | null>();
/** Single-function syncs, keyed `<account key>/<region>/<name>`. */
const runningFunctions = new Map<string, Promise<void>>();
const queuedFunctions = new Set<string>();

const keyOf = (a: Pick<AwsAccount, 'tenant_id' | 'id'>) => `${a.tenant_id}/${a.id}`;

export const isSyncing = (account: AwsAccount) => running.has(keyOf(account));

/** Resolves once no account or function sync of this account is running (including follow-up runs). */
export async function syncInProgress(account: AwsAccount): Promise<void> {
  const key = keyOf(account);
  for (;;) {
    const pending = [...runningFunctions].filter(([k]) => k.startsWith(`${key}/`)).map(([, run]) => run);
    const whole = running.get(key);
    if (whole) pending.push(whole);
    if (!pending.length) return;
    await Promise.all(pending);
  }
}

/**
 * Starts a sync unless one is already running for this account in this process; requests that
 * arrive meanwhile are merged and run once it finishes.
 */
export function triggerSync(account: AwsAccount, regions?: string[]): Promise<void> {
  const key = keyOf(account);
  const current = running.get(key);
  if (current) {
    const prev = queued.get(key);
    queued.set(key, !regions || prev === null ? null : new Set([...(prev ?? []), ...regions]));
    return current;
  }

  const run = syncAccount(account, { regions })
    .catch((err) => console.error(`aws sync ${key} failed`, err))
    .finally(async () => {
      running.delete(key);
      if (!queued.has(key)) return;
      const next = queued.get(key);
      queued.delete(key);
      const latest = await awsStore().getAccount(account.tenant_id, account.id).catch(() => null);
      if (latest && latest.status !== 'pending') void triggerSync(latest, next ? [...next] : undefined);
    });
  running.set(key, run);
  return run;
}

/**
 * Syncs one function (from an EventBridge event). Like `triggerSync`, a request that arrives while the same
 * function is syncing runs once afterwards. Falls back to a sync of the region when the function can't be read
 * (e.g. it was deleted).
 */
export function triggerFunctionSync(account: AwsAccount, region: string, name: string): Promise<void> {
  const key = `${keyOf(account)}/${region}/${name}`;
  const current = runningFunctions.get(key);
  if (current) {
    queuedFunctions.add(key);
    return current;
  }

  const run = syncFunction(account, region, name)
    .then(() => undefined)
    .catch((err) => {
      console.warn(`aws sync ${key} failed, syncing the region`, err);
      return triggerSync(account, [region]);
    })
    .finally(() => {
      runningFunctions.delete(key);
      if (queuedFunctions.delete(key)) void triggerFunctionSync(account, region, name);
    });
  runningFunctions.set(key, run);
  return run;
}

export async function syncDueAccounts(now = Date.now(), interval = syncIntervalMs()) {
  const accounts = await awsStore().listActiveAccounts();
  for (const account of accounts) {
    if (!isSyncing(account) && now - account.last_sync_at >= interval) void triggerSync(account);
  }
}

/** Background loop: every connected account is synced at least once per IVY_AWS_SYNC_INTERVAL_SECONDS. */
export function startSyncLoop(): (() => void) | null {
  const interval = syncIntervalMs();
  if (!interval) return null;
  const tick = () => syncDueAccounts(Date.now(), interval).catch((err) => console.error('aws sync loop', err));
  const timer = setInterval(tick, Math.min(interval, 60_000));
  timer.unref();
  setTimeout(tick, 5_000).unref();
  return () => clearInterval(timer);
}
