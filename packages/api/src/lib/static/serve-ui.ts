import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Serves the built UI from `root`, falling back to index.html for client-side routes. */
export function serveUi(root: string): MiddlewareHandler {
  const base = path.resolve(root);

  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();

    let pathname: string;
    try {
      pathname = decodeURIComponent(c.req.path);
    } catch {
      return c.text('Bad request', 400);
    }
    const requested = path.resolve(base, `.${path.posix.normalize(pathname)}`);
    const inside = requested === base || requested.startsWith(base + path.sep);

    let file = inside && (await isFile(requested)) ? requested : undefined;
    const isAsset = file !== undefined;
    if (!file) {
      const index = path.join(base, 'index.html');
      if (!(await isFile(index))) return c.text('UI not built', 404);
      file = index;
    }

    const body = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    c.header('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    c.header(
      'Cache-Control',
      isAsset && pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    if (c.req.method === 'HEAD') return c.body(null);
    return c.body(new Uint8Array(body));
  };
}
