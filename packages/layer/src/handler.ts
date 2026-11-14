import { loadConfig } from './lib/config/config.js';
import { helloExtension, sendToExtension } from './lib/extension/client.js';
import { ExportQueue } from './lib/export/queue.js';
import { instrumentAwsSdk } from './lib/instrumentation/aws-sdk.js';
import { instrumentConsole } from './lib/instrumentation/console.js';
import { instrumentFetch } from './lib/instrumentation/fetch.js';
import { instrumentHttp } from './lib/instrumentation/http.js';
import { loadUserHandler } from './lib/loader/user-function.js';
import { Tracer, type SpanBatch } from './lib/tracer/tracer.js';
import { wrapHandler } from './lib/tracer/wrap.js';

const STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming');

const originalWarn = console.warn.bind(console);
const config = loadConfig();
const log = (msg: string) => config.debug && originalWarn(`[ivy] ${msg}`);

async function setup(): Promise<Function> {
  const handlerString = process.env.IVY_ORIGINAL_HANDLER;
  if (!handlerString) throw new Error('[ivy] IVY_ORIGINAL_HANDLER is not set; use the /opt/ivy-wrapper exec wrapper.');
  const appRoot = process.env.LAMBDA_TASK_ROOT ?? process.cwd();

  let tracer: Tracer | undefined;
  if (config.enabled) {
    try {
      tracer = createTracer();
    } catch (e) {
      originalWarn(`[ivy] tracing disabled, setup failed: ${(e as Error).message}`);
    }
  }

  const user = await loadUserHandler(appRoot, handlerString);
  if (!tracer || (user as any)[STREAMING]) return user;
  tracer.onInvocationStart?.();
  return wrapHandler(tracer, user as any);
}

function createTracer(): Tracer {
  const viaExtension = helloExtension(config.extensionPort).then((ok) => {
    log(ok ? 'connected to ivy extension' : 'extension not reachable, exporting directly');
    return ok;
  });
  let queue: ExportQueue | undefined;
  const exportDirectly = (batch: SpanBatch) => {
    queue ??= new ExportQueue({
      url: config.tracesUrl!,
      apiKey: config.apiKey,
      maxQueueSpans: config.maxQueueSpans,
      exportTimeoutMs: config.exportTimeoutMs,
      log,
    });
    queue.add(batch);
    if (batch.final) queue.flush(config.flushBudgetMs).catch(() => {});
  };
  const sink = (batch: SpanBatch) => {
    viaExtension.then((ok) => {
      if (!ok) return exportDirectly(batch);
      sendToExtension(config.extensionPort, batch).then((sent) => {
        if (!sent) log(`could not hand spans for ${batch.requestId} to the extension`);
      });
    });
  };

  const tracer = new Tracer(config, sink, log);
  tracer.onInvocationStart = instrumentHttp(tracer);
  instrumentFetch(tracer);
  instrumentAwsSdk(tracer);
  if (config.captureLogs) instrumentConsole(tracer);
  return tracer;
}

export const handler = await setup();
