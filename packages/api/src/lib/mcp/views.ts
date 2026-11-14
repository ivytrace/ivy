import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ViewHtml } from '@ivy/mcp';

const NAMES = ['waterfall', 'graph'] as const;

/**
 * The MCP Apps views, built by `@ivy/ui build:mcp-apps` into `<uiDir>/mcp-apps/`. A view found once
 * is cached; a missing one is looked for again on the next request (dev: the UI may be built later),
 * and its tool answers in text until then.
 */
export function viewLoader(uiDir: string): () => Promise<ViewHtml> {
  const cache: ViewHtml = {};
  return async () => {
    await Promise.all(
      NAMES.filter((name) => !cache[name]).map(async (name) => {
        cache[name] = await readFile(path.join(uiDir, 'mcp-apps', `${name}.html`), 'utf8').catch(() => null);
      }),
    );
    return cache;
  };
}
