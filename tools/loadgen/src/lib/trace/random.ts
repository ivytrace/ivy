export function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function chance(probability: number): boolean {
  return Math.random() < probability;
}

export function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function weightedPick<T extends { weight: number }>(items: readonly T[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

/** Log-normal sample around `median` ms; `spread` ≈ sigma. */
export function latency(median: number, spread = 0.5): number {
  const u = 1 - Math.random();
  const v = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return median * Math.exp(normal * spread);
}

export function hex(length: number): string {
  let out = '';
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function shortId(prefix: string, length = 14): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}_${out}`;
}
