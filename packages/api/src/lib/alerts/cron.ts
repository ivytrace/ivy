/**
 * A five-field cron expression (minute hour day-of-month month day-of-week, UTC) with `*`, numbers,
 * lists, ranges and steps (`*\/15`, `1-5`, `0,30`). Day of week: 0 or 7 is Sunday. As in classic
 * cron, when both day fields are restricted, either may match.
 */
export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function field(text: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Invalid cron field "${text}"`);
    const lo = m[1] === '*' ? min : Number(m[2]);
    const hi = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    const step = m[4] ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`Invalid cron field "${text}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron needs five fields: "${expr}"`);
  const dow = field(parts[4], 0, 7);
  if (dow.has(7)) dow.add(0);
  return {
    minute: field(parts[0], 0, 59),
    hour: field(parts[1], 0, 23),
    dom: field(parts[2], 1, 31),
    month: field(parts[3], 1, 12),
    dow,
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

export function cronMatches(cron: Cron, at: Date): boolean {
  if (!cron.minute.has(at.getUTCMinutes()) || !cron.hour.has(at.getUTCHours()) || !cron.month.has(at.getUTCMonth() + 1)) return false;
  const dom = cron.dom.has(at.getUTCDate());
  const dow = cron.dow.has(at.getUTCDay());
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dow;
  if (cron.dowAny) return dom;
  return dom || dow;
}

/** The latest scheduled minute at or before `now`, looking back at most `withinMs`; null if none. */
export function lastRun(cron: Cron, now: number, withinMs: number): number | null {
  const start = Math.floor(now / 60_000) * 60_000;
  for (let t = start; t > now - withinMs; t -= 60_000) {
    if (cronMatches(cron, new Date(t))) return t;
  }
  return null;
}
