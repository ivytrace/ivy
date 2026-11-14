import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const opt = join(out, 'opt');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(opt, 'nodejs/ivy'), { recursive: true });
mkdirSync(join(opt, 'extensions'), { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node20', minify: true, legalComments: 'none', logLevel: 'warning' };

await build({
  ...common,
  entryPoints: [join(root, 'src/handler.ts')],
  format: 'esm',
  outfile: join(opt, 'nodejs/ivy/handler.mjs'),
});

await build({
  ...common,
  entryPoints: [join(root, 'src/extension.ts')],
  format: 'cjs',
  outfile: join(opt, 'extensions/ivy-extension'),
  banner: { js: '#!/usr/bin/env node' },
});
chmodSync(join(opt, 'extensions/ivy-extension'), 0o755);

copyFileSync(join(root, 'layer/ivy-wrapper'), join(opt, 'ivy-wrapper'));
chmodSync(join(opt, 'ivy-wrapper'), 0o755);
writeFileSync(join(opt, 'nodejs/ivy/package.json'), JSON.stringify({ type: 'module' }) + '\n');

execFileSync('zip', ['-q', '-r', '-X', join(out, 'layer.zip'), '.'], { cwd: opt });

const size = (p) => `${(statSync(join(opt, p)).size / 1024).toFixed(1)} KB`;
console.log(`handler.mjs      ${size('nodejs/ivy/handler.mjs')}`);
console.log(`ivy-extension    ${size('extensions/ivy-extension')}`);
console.log(`layer.zip        ${(statSync(join(out, 'layer.zip')).size / 1024).toFixed(1)} KB -> ${join(out, 'layer.zip')}`);
