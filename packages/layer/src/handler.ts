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
      tracer = await createTracer();
    } catch (e) {
      originalWarn(`[ivy] tracing disabled, setup failed: ${(e as Error).message}`);
      tracer = undefined;
    }
  }

  const user = await loadUserHandler(appRoot, handlerString);
  if (!tracer || (user as any)[STREAMING]) return user;
  return wrapHandler(tracer, user as any);
}

async function createTracer(): Promise<Tracer> {
  const viaExtension = await helloExtension(config.extensionPort);
  log(viaExtension ? 'connected to ivy extension' : 'extension not reachable, exporting directly');

  let sink: (batch: SpanBatch) => void;
  if (viaExtension) {
    sink = (batch) => {
      sendToExtension(config.extensionPort, batch).then((ok) => {
        if (!ok) log(`could not hand spans for ${batch.requestId} to the extension`);
      });
    };
  } else {
    const queue = new ExportQueue({
      url: config.tracesUrl!,
      apiKey: config.apiKey,
      maxQueueSpans: config.maxQueueSpans,
      exportTimeoutMs: config.exportTimeoutMs,
      log,
    });
    sink = (batch) => {
      queue.add(batch);
      if (batch.final) queue.flush(config.flushBudgetMs).catch(() => {});
    };
  }

  const tracer = new Tracer(config, sink, log);
  instrumentHttp(tracer);
  instrumentFetch(tracer);
  instrumentAwsSdk(tracer);
  if (config.captureLogs) instrumentConsole(tracer);
  return tracer;
}

export const handler = await setup();
