import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

class RuntimeError extends Error {
  constructor(name: string, message: string, cause?: unknown) {
    super(message);
    this.name = `Runtime.${name}`;
    if (cause instanceof Error && cause.stack) this.stack = `${this.name}: ${message}\n${cause.stack}`;
  }
}

const FUNCTION_EXPR = /^([^.]*)\.(.*)$/;
const require = createRequire(import.meta.url);

function hasTypeModule(folder: string): boolean {
  if (folder.endsWith('/node_modules')) return false;
  const pj = path.join(folder, 'package.json');
  if (existsSync(pj)) {
    try {
      return JSON.parse(readFileSync(pj, 'utf8'))?.type === 'module';
    } catch {
      return false;
    }
  }
  const parent = path.resolve(folder, '..');
  return parent === folder ? false : hasTypeModule(parent);
}

const tryRequire = (file: string) => (existsSync(file) ? require(file) : undefined);
const tryImport = async (file: string) => (existsSync(file) ? import(pathToFileURL(file).href) : undefined);

/** Mirrors the Node.js runtime's loading order for `.js`/`.mjs`/`.cjs` handlers (CJS and ESM). */
async function loadModule(appRoot: string, moduleRoot: string, moduleName: string): Promise<any> {
  const base = path.resolve(appRoot, moduleRoot, moduleName);
  const extensionless = tryRequire(base);
  if (extensionless) return extensionless;
  const isEsm = existsSync(`${base}.js`) && hasTypeModule(path.dirname(base));
  if (!isEsm) {
    const loaded = tryRequire(`${base}.js`);
    if (loaded) return loaded;
  }
  const loaded = (isEsm && (await tryImport(`${base}.js`))) || (await tryImport(`${base}.mjs`)) || tryRequire(`${base}.cjs`);
  if (loaded) return loaded;
  return require(require.resolve(moduleName, { paths: [appRoot, moduleRoot] }));
}

export async function loadUserHandler(appRoot: string, handlerString: string): Promise<Function> {
  if (handlerString.includes('..')) {
    throw new RuntimeError('MalformedHandlerName', `'${handlerString}' is not a valid handler name. Use absolute paths when specifying root directories in handler names.`);
  }
  const moduleAndHandler = path.basename(handlerString);
  const moduleRoot = handlerString.substring(0, handlerString.indexOf(moduleAndHandler));
  const match = FUNCTION_EXPR.exec(moduleAndHandler);
  if (!match) throw new RuntimeError('MalformedHandlerName', 'Bad handler');
  const [, moduleName, handlerPath] = match;

  let app: any;
  try {
    app = await loadModule(appRoot, moduleRoot, moduleName);
  } catch (e: any) {
    if (e instanceof SyntaxError) throw new RuntimeError('UserCodeSyntaxError', `${e.name}: ${e.message}`, e);
    if (e?.code === 'MODULE_NOT_FOUND') throw new RuntimeError('ImportModuleError', `Error: ${e.message}`, e);
    throw e;
  }
  const fn = handlerPath.split('.').reduce((obj: any, key) => obj?.[key], app);
  if (!fn) throw new RuntimeError('HandlerNotFound', `${handlerString} is undefined or not exported`);
  if (typeof fn !== 'function') throw new RuntimeError('HandlerNotFound', `${handlerString} is not a function`);
  return fn;
}
