import { alertLoopMs, digestEnabled, slackEnabled } from './config.js';
import { sendDueDigests } from './digest.js';
import { evaluateAlerts, type EvaluateOptions } from './evaluate.js';
import { acquireLease, processHolder } from './lease.js';

/**
 * One job per API install: the alert evaluator and the digest run in whichever API process holds the
 * `alerts` lease. A run never overlaps the previous one in the same process.
 */
export function alertRunner(holder = processHolder(), options: EvaluateOptions = {}) {
  let running: Promise<boolean> | null = null;
  const hookSince = options.hookSince ?? Date.now();

  async function run(now: number, intervalMs: number): Promise<boolean> {
    // The lease outlives a missed tick or two, so a slow run doesn't hand over mid-way.
    if (!(await acquireLease('alerts', holder, Math.max(3 * intervalMs, 60_000), now))) return false;
    await evaluateAlerts({ ...options, now, hookSince }).catch((err) => console.error('[alerts] evaluation failed', err));
    await sendDueDigests(now).catch((err) => console.error('[digest] run failed', err));
    return true;
  }

  return {
    /** Runs once unless a run is in progress; resolves to whether this process held the lease. */
    tick(now = Date.now(), intervalMs = alertLoopMs()): Promise<boolean> {
      if (running) return running;
      running = run(now, intervalMs).finally(() => {
        running = null;
      });
      return running;
    },
  };
}

/** Background loop of the API process (index.ts). Off with IVY_ALERTS_INTERVAL_SECONDS=0. */
export function startAlertLoop(): (() => void) | null {
  const interval = alertLoopMs();
  if (!interval) return null;
  const runner = alertRunner(undefined, { spacingMs: 1100 });
  const tick = () => {
    void runner.tick(Date.now(), interval).catch((err) => console.error('[alerts] loop', err));
  };
  const timer = setInterval(tick, interval);
  timer.unref();
  setTimeout(tick, 10_000).unref();
  console.log(`Alerts: Slack ${slackEnabled() ? 'on' : 'off'}, weekly digest ${digestEnabled() ? 'on' : 'off'}`);
  return () => clearInterval(timer);
}
