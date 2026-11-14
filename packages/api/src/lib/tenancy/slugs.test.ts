import { beforeEach, describe, expect, it } from 'vitest';
import { createProject } from './projects.js';
import { claimSlug, slugCandidates, slugify } from './slugs.js';
import type { TenancyStore } from './store.js';
import { createTenant } from './tenants.js';
import { resetTenancyForTests } from './testing.js';

let store: TenancyStore;
beforeEach(async () => {
  store = await resetTenancyForTests();
});

describe('slugify', () => {
  it('folds, lowercases, dashes and trims names', () => {
    expect(slugify('Checkout (prod)')).toBe('checkout-prod');
    expect(slugify('  Équipe Café — Paris!  ')).toBe('equipe-cafe-paris');
    expect(slugify('a'.repeat(60))).toHaveLength(40);
    expect(slugify('日本', 'project')).toBe('project');
    expect(slugify('---')).toBe('workspace');
  });

  it('numbers collisions within 40 characters', () => {
    const it = slugCandidates('x'.repeat(40));
    expect(it.next().value).toBe('x'.repeat(40));
    expect(it.next().value).toBe(`${'x'.repeat(38)}-2`);
  });
});

describe('generated slugs', () => {
  it('append -2, -3 for workspaces and per workspace for projects', async () => {
    const [a, b, c] = await Promise.all([createTenant('Acme'), createTenant('Acme'), createTenant('Acme')]);
    expect([a.slug, b.slug, c.slug].sort()).toEqual(['acme', 'acme-2', 'acme-3']);
    const [p, q] = await Promise.all([createProject(a.id, { name: 'Checkout (prod)' }), createProject(a.id, { name: 'Checkout (prod)' })]);
    expect([p.slug, q.slug].sort()).toEqual(['checkout-prod', 'checkout-prod-2']);
    expect((await createProject(b.id, { name: 'Checkout (prod)' })).slug).toBe('checkout-prod');
    expect((await createProject(a.id, { name: 'All' })).slug).toBe('all-2');
  });

  it('resolves a race between processes: the older record keeps the slug, the newer moves on', async () => {
    // Two "processes" (separate claim scopes, so no in-process serialization) claim the same slug at once.
    const records = [
      { id: 'ten_older', slug: '', name: 'Acme', shard_id: 'shard-1', created_at: 1 },
      { id: 'ten_newer', slug: '', name: 'Acme', shard_id: 'shard-1', created_at: 2 },
    ];
    const claim = (t: (typeof records)[number], scope: string) =>
      claimSlug({
        scope,
        base: 'acme',
        // Both look before either writes.
        taken: async (slug) => slug !== 'acme' && !!(await store.findTenantBySlug(slug)),
        write: (slug) => store.saveTenant({ ...t, slug }),
        won: async (slug) => (await store.findTenantBySlug(slug))?.id === t.id,
      });
    const [newer, older] = await Promise.all([claim(records[1], 'process-a'), claim(records[0], 'process-b')]);
    expect(older).toBe('acme');
    expect(newer).toBe('acme-2');
  });
});
