/** Lower-case letters, digits and single dashes, 1–40 characters, starting and ending alphanumeric. */
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;
const MAX = 40;

/** Project slugs the UI routes use as path segments (`/w/:workspace/all/…`, `/w/:workspace/settings`). */
export const RESERVED_PROJECT_SLUGS = ['all', 'settings'];

export const isSlug = (value: string) => SLUG.test(value);

/**
 * A slug from a display name: lower case, accents folded to ASCII, everything else non-alphanumeric
 * becomes `-`, dashes collapsed and trimmed, at most 40 characters; `fallback` when nothing is left.
 * "Checkout (prod)" → "checkout-prod".
 */
export function slugify(name: string, fallback = 'workspace'): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/, '');
  return slug || fallback;
}

/** `base`, `base-2`, `base-3`, …, each at most 40 characters. */
export function* slugCandidates(base: string): Generator<string> {
  yield base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    yield `${base.slice(0, MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
}

export interface SlugClaim {
  /** Serializes claims within this process (e.g. `workspace` or `project:<tenant>`). */
  scope: string;
  base: string;
  /** True when the slug is taken by something else (or reserved). */
  taken(slug: string): Promise<boolean>;
  /** Stores the record with this slug. */
  write(slug: string): Promise<void>;
  /** True when, after writing, this record is the one that owns the slug (the oldest holder wins). */
  won(slug: string): Promise<boolean>;
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Picks the first free slug of `base`, `base-2`, `base-3`, … and stores it. ClickHouse has no unique
 * constraint, so after writing, the record checks that it is the oldest holder of the slug; if another
 * process wrote the same slug first, the newer record moves on to the next candidate. Within one
 * process claims of a scope run one at a time, so they never collide.
 */
export function claimSlug(claim: SlugClaim): Promise<string> {
  const previous = queues.get(claim.scope) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    for (const slug of slugCandidates(claim.base)) {
      if (await claim.taken(slug)) continue;
      await claim.write(slug);
      if (await claim.won(slug)) return slug;
    }
    throw new Error('unreachable');
  });
  queues.set(claim.scope, run);
  run.finally(() => queues.get(claim.scope) === run && queues.delete(claim.scope)).catch(() => {});
  return run;
}
