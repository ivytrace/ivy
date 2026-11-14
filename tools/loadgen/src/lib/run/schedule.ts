import { FUNCTIONS, INCIDENT_FUNCTION } from '../functions/catalog.js';
import { generateInvocation, type FunctionDef, type GeneratedInvocation } from '../trace/generate.js';
import { chance, weightedPick } from '../trace/random.js';

const HOUR = 3_600_000;
const IDLE_BEFORE_COLD_MS = 7 * 60_000;

/** Traffic shape over the day (UTC): quiet at night, peak in the afternoon. */
export function diurnalWeight(ms: number): number {
  const hour = new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() / 60;
  return 1 + 0.6 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
}

/** `count` sorted timestamps in [now - hours, now], denser during the day. */
export function backfillTimestamps(count: number, hours: number, now: number): number[] {
  const from = now - hours * HOUR;
  const out: number[] = [];
  while (out.length < count) {
    const ts = from + Math.random() * (now - from);
    if (Math.random() * 1.6 < diurnalWeight(ts)) out.push(ts);
  }
  return out.sort((a, b) => a - b);
}

export interface Incident {
  functionName: string;
  from: number;
  to: number;
  boost: number;
}

/** A short error spike on one function, placed ~40% into the backfill window. */
export function incidentFor(hours: number, now: number): Incident | undefined {
  if (hours < 2) return undefined;
  const length = Math.min(45 * 60_000, hours * HOUR * 0.04);
  const to = now - hours * HOUR * 0.4;
  return { functionName: INCIDENT_FUNCTION, from: to - length, to, boost: 0.3 };
}

export class InvocationSource {
  private lastSeen = new Map<string, number>();

  constructor(
    private readonly incident?: Incident,
    private readonly functions: FunctionDef[] = FUNCTIONS,
  ) {}

  next(ts: number): GeneratedInvocation {
    const fn = weightedPick(this.functions);
    const last = this.lastSeen.get(fn.name);
    this.lastSeen.set(fn.name, ts);
    const coldStart = last === undefined || ts - last > IDLE_BEFORE_COLD_MS || chance(0.025);
    const inIncident =
      this.incident && fn.name === this.incident.functionName && ts >= this.incident.from && ts < this.incident.to;
    return generateInvocation(fn, ts, { coldStart, errorBoost: inIncident ? this.incident!.boost : 0 });
  }
}
