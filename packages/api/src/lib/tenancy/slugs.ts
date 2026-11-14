import { randomBase62 } from './ids.js';

/** Lower-case letters, digits and single dashes, 1–40 characters, starting and ending alphanumeric. */
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;

/** Project slugs the UI routes use as path segments (`/w/:workspace/all/…`, `/w/:workspace/settings`). */
export const RESERVED_PROJECT_SLUGS = ['all', 'settings'];

export const isSlug = (value: string) => SLUG.test(value);

/** A slug from a display name ("Checkout (prod)" → "checkout-prod"), or `fallback` if nothing is left. */
export function slugify(name: string, fallback = 'workspace'): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug || fallback;
}

/** `base`, or `base-<4 random characters>` until `taken` says no. */
export async function uniqueSlug(base: string, taken: (slug: string) => Promise<boolean> | boolean): Promise<string> {
  if (!(await taken(base))) return base;
  for (;;) {
    const candidate = `${base.slice(0, 35)}-${randomBase62(4).toLowerCase()}`;
    if (isSlug(candidate) && !(await taken(candidate))) return candidate;
  }
}
