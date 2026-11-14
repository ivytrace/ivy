import { parseArgs } from 'node:util';

export interface Options {
  count: number;
  rate: number;
  backfillHours: number;
  endpoint: string;
  key: string;
  batch: number;
}

export const USAGE = `Usage: pnpm --filter loadgen start [options]

  --count <n>          invocations to send (default 500; 0 = run until Ctrl+C, live mode only)
  --rate <n>           invocations per second (default 20 live, unlimited with --backfill)
  --backfill <hours>   spread timestamps over the past N hours instead of "now"
  --endpoint <url>     OTLP/HTTP base URL (default http://localhost:4318, env IVY_OTLP_ENDPOINT)
  --key <key>          ingest API key (default env IVY_INGEST_API_KEY or dev-ingest-key)
  --batch <n>          invocations per request (default 100)
  --help`;

function num(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --${name}: ${value}`);
  return n;
}

export function parseOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): Options | 'help' {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      count: { type: 'string' },
      rate: { type: 'string' },
      backfill: { type: 'string' },
      endpoint: { type: 'string' },
      key: { type: 'string' },
      batch: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return 'help';
  const backfillHours = num(values.backfill, 'backfill', 0);
  const count = Math.floor(num(values.count, 'count', 500));
  if (count === 0 && backfillHours > 0) throw new Error('--count 0 (run forever) is only supported in live mode');
  return {
    count,
    rate: num(values.rate, 'rate', backfillHours > 0 ? 0 : 20),
    backfillHours,
    endpoint: values.endpoint ?? env.IVY_OTLP_ENDPOINT ?? 'http://localhost:4318',
    key: values.key ?? env.IVY_INGEST_API_KEY ?? 'dev-ingest-key',
    batch: Math.max(1, Math.floor(num(values.batch, 'batch', 100))),
  };
}
