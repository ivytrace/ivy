import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const opt = join(out, 'opt');
const ARCHES = { x86_64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' };
rmSync(out, { recursive: true, force: true });
mkdirSync(join(opt, 'nodejs/ivy'), { recursive: true });
mkdirSync(join(opt, 'extensions'), { recursive: true });
mkdirSync(join(opt, 'ivy/bin'), { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node20', minify: true, legalComments: 'none', logLevel: 'warning' };
await build({
  ...common,
  entryPoints: [join(root, 'src/handler.ts')],
  format: 'esm',
  outfile: join(opt, 'nodejs/ivy/handler.mjs'),
  metafile: !!process.env.IVY_METAFILE,
}).then((r) => r.metafile && writeFileSync(join(out, 'meta.json'), JSON.stringify(r.metafile)));
// Loaded with --require into every worker thread (see docs/implementation/layer.md, "Worker threads").
await build({ ...common, entryPoints: [join(root, 'src/worker.ts')], format: 'cjs', outfile: join(opt, 'nodejs/ivy/worker.cjs') });

copyFileSync(join(root, 'layer/ivy-wrapper'), join(opt, 'ivy-wrapper'));
copyFileSync(join(root, 'layer/ivy-extension'), join(opt, 'extensions/ivy-extension'));
writeFileSync(join(opt, 'nodejs/ivy/package.json'), JSON.stringify({ type: 'module' }) + '\n');
for (const file of ['ivy-wrapper', 'extensions/ivy-extension']) chmodSync(join(opt, file), 0o755);

// The extension is Rust (see docs/implementation/layer.md). Order of preference: prebuilt binaries
// in IVY_EXTENSION_BIN_DIR (the API image builds them in its own stage), a local `cargo zigbuild`, Docker.
const crate = join(root, 'extension');
const prebuilt = process.env.IVY_EXTENSION_BIN_DIR;
let binDir = prebuilt;
if (!binDir) {
  binDir = join(out, 'extension-bin');
  const hasZigbuild = spawnSync('cargo', ['zigbuild', '--version'], { stdio: 'ignore' }).status === 0;
  if (hasZigbuild) {
    const targets = Object.values(ARCHES).flatMap((t) => ['--target', t]);
    execFileSync('cargo', ['zigbuild', '--locked', '--release', ...targets], { cwd: crate, stdio: 'inherit' });
    mkdirSync(binDir, { recursive: true });
    for (const [arch, target] of Object.entries(ARCHES)) {
      copyFileSync(join(crate, 'target', target, 'release/ivy-extension'), join(binDir, `ivy-extension-${arch}`));
    }
  } else {
    console.log('cargo zigbuild not found; building the extension in Docker');
    execFileSync('docker', ['build', '--quiet', '-f', join(crate, 'Dockerfile'), '--output', `type=local,dest=${binDir}`, crate], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
}
for (const arch of Object.keys(ARCHES)) {
  const src = join(binDir, `ivy-extension-${arch}`);
  if (!existsSync(src)) throw new Error(`missing extension binary ${src}`);
  copyFileSync(src, join(opt, `ivy/bin/ivy-extension-${arch}`));
  chmodSync(join(opt, `ivy/bin/ivy-extension-${arch}`), 0o755);
}

execFileSync('zip', ['-q', '-r', '-X', join(out, 'layer.zip'), '.'], { cwd: opt });

const size = (p) => `${(statSync(join(opt, p)).size / 1024).toFixed(1)} KB`;
console.log(`handler.mjs                ${size('nodejs/ivy/handler.mjs')}`);
console.log(`worker.cjs                 ${size('nodejs/ivy/worker.cjs')}`);
for (const arch of Object.keys(ARCHES)) console.log(`ivy-extension-${arch.padEnd(12)}${size(`ivy/bin/ivy-extension-${arch}`)}`);
console.log(`layer.zip                  ${(statSync(join(out, 'layer.zip')).size / 1024).toFixed(1)} KB -> ${join(out, 'layer.zip')}`);
