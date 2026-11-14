import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ViewHtml } from '@ivy/mcp';

const NAMES = ['waterfall', 'graph'] as const;

/**
 * The MCP Apps views, built by `@ivy/ui build:mcp-apps` into `<uiDir>/mcp-apps/`. Each request stats
 * the files and re-reads one only when it changed, so a rebuilt (or later built) UI is picked up
 * without a restart. A missing view leaves its tool answering in text.
 */
export function viewLoader(uiDir: string): () => Promise<ViewHtml> {
  const cache = new Map<string, { mtimeMs: number; html: string }>();
  return async () => {
    const views: ViewHtml = {};
    await Promise.all(
      NAMES.map(async (name) => {
        const file = path.join(uiDir, 'mcp-apps', `${name}.html`);
        const info = await stat(file).catch(() => null);
        if (!info) return;
        let hit = cache.get(name);
        if (!hit || hit.mtimeMs !== info.mtimeMs) {
          hit = { mtimeMs: info.mtimeMs, html: await readFile(file, 'utf8') };
          cache.set(name, hit);
        }
        views[name] = hit.html;
      }),
    );
    return views;
  };
}
