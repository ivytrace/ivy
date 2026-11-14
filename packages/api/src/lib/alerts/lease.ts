import { hostname } from 'node:os';
import { randomBase62 } from '../tenancy/ids.js';
import { alertStore, type Lease } from './store.js';

/** This process's identity in job leases. */
export const processHolder = () => `${hostname()}:${process.pid}:${randomBase62(6)}`;

const leader = (leases: Lease[], now: number) =>
  leases.filter((l) => l.expires_at > now).sort((a, b) => a.since - b.since || a.holder.localeCompare(b.holder))[0];

/**
 * A best-effort single-instance lease in the control database (no transactions there): each holder
 * keeps its own row alive, and the live row with the oldest `since` leads. A holder that sees another
 * live leader backs off; after writing its row it reads again, so two processes that claim at the
 * same moment agree on one of them (docs/implementation/alerts.md, "One evaluator").
 */
export async function acquireLease(name: string, holder: string, ttlMs: number, now = Date.now()): Promise<boolean> {
  const store = alertStore();
  const before = await store.listLeases(name);
  const current = leader(before, now);
  if (current && current.holder !== holder) return false;
  const mine = before.find((l) => l.holder === holder && l.expires_at > now);
  await store.saveLease({ name, holder, since: mine?.since ?? now, expires_at: now + ttlMs });
  return leader(await store.listLeases(name), now)?.holder === holder;
}
