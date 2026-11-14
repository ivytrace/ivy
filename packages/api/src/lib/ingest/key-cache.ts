import { hashKey, workspaceDefaultProject } from '../tenancy/ids.js';
import type { KeyMatch } from '../tenancy/store.js';

export interface ResolvedKey {
  tenantId: string;
  projectId: string;
  shardId: string;
  keyId: string;
}

export interface KeyCacheOptions {
  lookup: (hash: string) => Promise<KeyMatch | null>;
  ttlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * The key's tenant, shard and project. A key of an archived project is rejected like a revoked one.
 * Keys without a project (`project_id` '') follow the workspace's current default project, which may
 * not have a row yet right after the upgrade; any other missing project rejects the key.
 */
function resolvedKey(match: KeyMatch): ResolvedKey | null {
  const fallback = workspaceDefaultProject(match.tenant);
  const projectId = match.key.project_id || fallback;
  if (match.project ? match.project.archived : projectId !== fallback) return null;
  return { tenantId: match.tenant.id, projectId, shardId: match.tenant.shard_id, keyId: match.key.id };
}

/**
 * API key → tenant and project, cached by key hash. Valid keys for `ttlMs`, unknown keys for `negativeTtlMs`
 * (so a flood of bad keys doesn't reach the control database). A revoked key or a tenant move
 * takes effect within `ttlMs`. Concurrent lookups of one key share a request.
 */
export class KeyCache {
  private entries = new Map<string, { value: ResolvedKey | null; expires: number }>();
  private inflight = new Map<string, Promise<ResolvedKey | null>>();
  private ttlMs: number;
  private negativeTtlMs: number;
  private maxEntries: number;
  private now: () => number;

  constructor(private opts: KeyCacheOptions) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.negativeTtlMs = opts.negativeTtlMs ?? 30_000;
    this.maxEntries = opts.maxEntries ?? 50_000;
    this.now = opts.now ?? Date.now;
  }

  /** Cached valid key, without a lookup. */
  peek(key: string): ResolvedKey | null {
    const hit = this.entries.get(hashKey(key));
    return hit && hit.expires > this.now() ? hit.value : null;
  }

  async resolve(key: string): Promise<ResolvedKey | null> {
    const hash = hashKey(key);
    const hit = this.entries.get(hash);
    if (hit && hit.expires > this.now()) return hit.value;
    let pending = this.inflight.get(hash);
    if (!pending) {
      pending = this.load(hash).finally(() => this.inflight.delete(hash));
      this.inflight.set(hash, pending);
    }
    return pending;
  }

  private async load(hash: string): Promise<ResolvedKey | null> {
    const match = await this.opts.lookup(hash);
    const value = match ? resolvedKey(match) : null;
    if (this.entries.size >= this.maxEntries) {
      // Drop the oldest tenth (Map iteration is insertion order).
      let drop = Math.ceil(this.maxEntries / 10);
      for (const k of this.entries.keys()) {
        if (drop-- <= 0) break;
        this.entries.delete(k);
      }
    }
    this.entries.delete(hash);
    this.entries.set(hash, { value, expires: this.now() + (value ? this.ttlMs : this.negativeTtlMs) });
    return value;
  }
}
