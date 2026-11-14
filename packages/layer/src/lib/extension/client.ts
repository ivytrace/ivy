import type { SpanBatch } from '../tracer/tracer.js';
import { post } from '../export/transport.js';

const base = (port: number) => `http://127.0.0.1:${port}`;

/**
 * Announces the in-process tracer to the extension, so it waits for spans before each `/next`.
 * Init does not wait for the answer (the extension expects the hello whenever the exec wrapper is
 * configured); the result only decides where spans go. A raw socket because the first
 * `http.request` in a process costs a few ms. Unref'd so it never holds up callback handlers.
 */
export function helloExtension(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    let response = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(/^HTTP\/1\.[01] 200 /.test(response));
    };
    const body = JSON.stringify({ pid: process.pid });
    const socket = process.getBuiltinModule('node:net').connect(port, '127.0.0.1');
    const timer = setTimeout(finish, timeoutMs).unref();
    socket.unref();
    socket.setEncoding('latin1');
    // Queued until connected, so the request goes out without waiting for a 'connect' callback.
    socket.write(`POST /hello HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.includes('\r\n')) finish();
    });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hands a batch to the extension's intake. Connection errors are retried briefly (the intake may
 * open a moment after init started); a non-200 answer is not.
 */
export async function sendToExtension(port: number, batch: SpanBatch, timeoutMs = 1000, retryDelaysMs = [50, 150, 300]): Promise<boolean> {
  const body = JSON.stringify(batch);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await post(`${base(port)}/spans`, body, { timeoutMs, keepAlive: false });
      return res.status === 200;
    } catch {
      if (attempt >= retryDelaysMs.length) return false;
      await sleep(retryDelaysMs[attempt]);
    }
  }
}

/** True when the layer's exec wrapper is active and the extension is installed next to it. */
export function extensionInstalled(
  env: NodeJS.ProcessEnv = process.env,
  exists = (p: string) => process.getBuiltinModule('node:fs').existsSync(p),
): boolean {
  return !!env.AWS_LAMBDA_EXEC_WRAPPER?.endsWith('/ivy-wrapper') && exists('/opt/extensions/ivy-extension');
}

export interface ExtensionLinkOptions {
  port: number;
  /** The extension is installed: never fall back to exporting directly, even if the hello fails. */
  expected: boolean;
  log?: (msg: string) => void;
  hello?: (port: number) => Promise<boolean>;
}

/**
 * Decides where spans go. When the extension is installed spans always go to its intake, and a hello
 * that failed at init (the intake not open yet) is repeated at the first invocation. Without the
 * extension, a failed hello means exporting directly.
 */
export class ExtensionLink {
  /** Resolves to true when spans should go to the extension. */
  readonly viaExtension: Promise<boolean>;
  private helloOk = false;
  private retried = false;
  private hello: (port: number) => Promise<boolean>;

  constructor(private opts: ExtensionLinkOptions) {
    this.hello = opts.hello ?? helloExtension;
    this.viaExtension = this.hello(opts.port).then((ok) => {
      this.helloOk = ok;
      if (ok) opts.log?.('connected to ivy extension');
      else opts.log?.(opts.expected ? 'extension not reachable yet, will retry' : 'extension not reachable, exporting directly');
      return ok || opts.expected;
    });
  }

  /** At the start of an invocation: repeats a failed hello once, so the extension waits for this invocation's spans. */
  onInvocationStart(): void {
    if (this.helloOk || this.retried || !this.opts.expected) return;
    this.retried = true;
    this.hello(this.opts.port).then((ok) => {
      this.helloOk ||= ok;
      this.opts.log?.(ok ? 'connected to ivy extension (retry)' : 'extension still not reachable');
    });
  }
}
