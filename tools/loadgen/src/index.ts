import { parseOptions, USAGE, type Options } from './lib/cli/options.js';
import { backfillTimestamps, incidentFor, InvocationSource } from './lib/run/schedule.js';
import { sendBatch } from './lib/send/sender.js';
import type { GeneratedInvocation } from './lib/trace/generate.js';

const MAX_IN_FLIGHT = 4;

interface Stats {
  invocations: number;
  spans: number;
  errors: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function record(stats: Stats, batch: GeneratedInvocation[]) {
  stats.invocations += batch.length;
  stats.spans += batch.reduce((sum, inv) => sum + inv.spans.length, 0);
  stats.errors += batch.filter((inv) => inv.error).length;
}

async function runBackfill(opts: Options, stats: Stats) {
  const now = Date.now();
  const incident = incidentFor(opts.backfillHours, now);
  if (incident) {
    console.log(
      `Simulated incident on ${incident.functionName} from ${new Date(incident.from).toISOString()} to ${new Date(incident.to).toISOString()}`,
    );
  }
  const source = new InvocationSource(incident);
  const timestamps = backfillTimestamps(opts.count, opts.backfillHours, now);
  const started = Date.now();
  const inFlight = new Set<Promise<void>>();

  for (let i = 0; i < timestamps.length; i += opts.batch) {
    const batch = timestamps.slice(i, i + opts.batch).map((ts) => source.next(ts));
    const promise = sendBatch(opts.endpoint, opts.key, batch).then(() => {
      record(stats, batch);
      inFlight.delete(promise);
    });
    inFlight.add(promise);
    if (inFlight.size >= MAX_IN_FLIGHT) await Promise.race(inFlight);
    if (opts.rate > 0) {
      const due = started + ((i + batch.length) / opts.rate) * 1000;
      await sleep(Math.max(0, due - Date.now()));
    }
    if ((i / opts.batch) % 20 === 0) process.stdout.write(`\r${stats.invocations}/${opts.count} invocations sent`);
  }
  await Promise.all(inFlight);
}

async function runLive(opts: Options, stats: Stats) {
  const source = new InvocationSource();
  const started = Date.now();
  let generated = 0;
  let stop = false;
  process.once('SIGINT', () => {
    stop = true;
  });

  while (!stop && (opts.count === 0 || generated < opts.count)) {
    const elapsed = (Date.now() - started) / 1000;
    const due = Math.floor(elapsed * opts.rate) + 1;
    const target = opts.count === 0 ? due : Math.min(opts.count, due);
    const size = Math.min(opts.batch, target - generated);
    if (size > 0) {
      const now = Date.now();
      const batch = Array.from({ length: size }, () => source.next(now - Math.random() * 1000));
      generated += size;
      await sendBatch(opts.endpoint, opts.key, batch);
      record(stats, batch);
      process.stdout.write(`\r${stats.invocations} invocations sent (${stats.errors} errors)`);
    }
    await sleep(250);
  }
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  if (opts === 'help') {
    console.log(USAGE);
    return;
  }
  const mode = opts.backfillHours > 0 ? `backfill ${opts.backfillHours}h` : 'live';
  console.log(`Sending ${opts.count || '∞'} invocations to ${opts.endpoint} (${mode}, rate ${opts.rate || 'unlimited'}/s)`);

  const stats: Stats = { invocations: 0, spans: 0, errors: 0 };
  const started = Date.now();
  if (opts.backfillHours > 0) await runBackfill(opts, stats);
  else await runLive(opts, stats);

  const seconds = (Date.now() - started) / 1000;
  console.log(
    `\nDone: ${stats.invocations} invocations, ${stats.spans} spans, ${stats.errors} errors ` +
      `(${((stats.errors / Math.max(1, stats.invocations)) * 100).toFixed(1)}%) in ${seconds.toFixed(1)}s`,
  );
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
