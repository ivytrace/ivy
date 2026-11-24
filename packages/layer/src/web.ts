import { loadConfig } from './lib/config/config.js';
import { instrumentAwsSdk } from './lib/instrumentation/aws-sdk.js';
import { instrumentConsole } from './lib/instrumentation/console.js';
import { instrumentFetch } from './lib/instrumentation/fetch.js';
import { instrumentHttp } from './lib/instrumentation/http.js';
import { installOtelBridge } from './lib/otel-bridge/index.js';
import { Tracer } from './lib/tracer/tracer.js';
import { createWebExporter } from './lib/web/exporter.js';
import { instrumentServer } from './lib/web/server.js';
import { instrumentWorkerThreads } from './lib/workers/parent.js';

// Entry point for Lambda Web Functions, preloaded with NODE_OPTIONS=--import (see docs/implementation/layer.md).
const originalWarn = console.warn.bind(console);
const config = loadConfig();
const log = (msg: string) => config.debug && originalWarn(`[ivy] ${msg}`);

if (config.enabled) {
  try {
    const exporter = createWebExporter(config, log);
    const tracer = new Tracer(config, exporter.sink, log);
    tracer.enableConcurrency();
    const checkHttps = instrumentHttp(tracer);
    const checkWorkers = config.captureWorkers ? instrumentWorkerThreads(tracer, `${import.meta.dirname}/worker.cjs`) : undefined;
    tracer.onInvocationStart = () => {
      checkHttps();
      checkWorkers?.();
    };
    instrumentFetch(tracer);
    instrumentAwsSdk(tracer);
    if (config.captureLogs) instrumentConsole(tracer);
    installOtelBridge(tracer);
    instrumentServer(tracer, { functionName: process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.IVY_FUNCTION_NAME || undefined });
  } catch (e) {
    originalWarn(`[ivy] tracing disabled, setup failed: ${(e as Error).message}`);
  }
}
