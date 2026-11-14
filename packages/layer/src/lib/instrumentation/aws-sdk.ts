import { now } from '../tracer/clock.js';
import { recordError, StatusCode, type Span } from '../tracer/span.js';
import type { Tracer } from '../tracer/tracer.js';
import { awsServiceAttributes, operationFromCommandName, serviceFromClientName } from './aws-attributes.js';
import { BEDROCK_OPERATIONS, BEDROCK_SERVICE, bedrockRequestAttributes, bedrockResponseAttributes, decodeJson, isBedrockConverse, isBedrockStream, tapBedrockStream } from './bedrock.js';
import { SKIP_HTTP } from './http-span.js';
import { onRequire } from './require-hook.js';

const PATCHED = Symbol.for('ivy.aws-sdk.patched');
const SPAN = Symbol.for('ivy.aws-sdk.span');
const CLIENT_MODULES = new Set(['@smithy/core/client', '@smithy/smithy-client', '@aws-sdk/smithy-client']);

function resolveRegion(config: any): Promise<string | undefined> {
  try {
    const r = config?.region;
    if (typeof r === 'string') return Promise.resolve(r);
    if (typeof r === 'function') return Promise.resolve(r()).then((v) => (typeof v === 'string' ? v : undefined), () => undefined);
  } catch {
    // ignore
  }
  return Promise.resolve(undefined);
}

function tracingMiddleware(tracer: Tracer, client: any) {
  return (next: any, context: any) => async (args: any) => {
    let span: Span | undefined;
    let service = '';
    let bedrock: string | undefined;
    try {
      if (tracer.active) {
        service = serviceFromClientName(context?.clientName) ?? 'AWS';
        const operation = operationFromCommandName(context?.commandName) ?? 'Unknown';
        span = tracer.startChild(`${service}.${operation}`);
        if (span) {
          span.attributes['rpc.system'] = 'aws-api';
          span.attributes['rpc.service'] = service;
          span.attributes['rpc.method'] = operation;
          // Targets (table, bucket, queue) from the input right away: collapsing groups calls by them.
          Object.assign(span.attributes, awsServiceAttributes(service, args?.input, undefined));
          if (service === BEDROCK_SERVICE && BEDROCK_OPERATIONS.has(operation)) {
            bedrock = operation;
            const input = args?.input;
            const body = isBedrockConverse(operation) ? input : decodeJson(input?.body);
            Object.assign(span.attributes, bedrockRequestAttributes(input?.modelId, body));
          }
          span.payloads.push({ key: 'ivy.payload.request', value: args?.input });
          context[SPAN] = span;
        }
      }
    } catch {
      span = undefined;
    }
    if (!span) return next(args);

    const s = span;
    const regionPromise = resolveRegion(client?.config);
    /** A streamed Bedrock response: the span ends, and gets its response, when the app has read the stream. */
    const tapStream = (output: any): boolean => {
      if (!bedrock || !isBedrockStream(bedrock) || !output) return false;
      try {
        const key = bedrock === 'ConverseStream' ? 'stream' : 'body';
        if (!output[key] || typeof output[key][Symbol.asyncIterator] !== 'function') return false;
        output[key] = tapBedrockStream(s, output[key]);
        return true;
      } catch {
        return false;
      }
    };
    const finish = async (result: any, err: any, streaming = false) => {
      try {
        const output = result?.output;
        if (!streaming) s.endMs = now();
        const region = await regionPromise;
        if (region) s.attributes['cloud.region'] = region;
        const meta = output?.$metadata ?? err?.$metadata;
        if (meta?.requestId) s.attributes['aws.request_id'] = meta.requestId;
        if (meta?.httpStatusCode) s.attributes['http.response.status_code'] = meta.httpStatusCode;
        Object.assign(s.attributes, awsServiceAttributes(service, args?.input, output, region));
        if (err) recordError(s, err, s.endMs ?? now());
        else if (!streaming) {
          if (s.status.code !== StatusCode.ERROR) s.status = { code: StatusCode.UNSET };
          const { $metadata: _ignored, ...rest } = output ?? {};
          s.payloads.push({ key: 'ivy.payload.response', value: rest });
          if (bedrock) {
            const body = isBedrockConverse(bedrock) ? output : decodeJson(output?.body);
            Object.assign(s.attributes, bedrockResponseAttributes(body, result?.response?.headers));
          }
        }
      } catch {
        // ignore
      }
    };
    try {
      const result = await next(args);
      finish(result, undefined, tapStream(result?.output));
      return result;
    } catch (err) {
      finish(undefined, err);
      throw err;
    }
  };
}

const markRequestMiddleware = (next: any, context: any) => async (args: any) => {
  try {
    const headers = args?.request?.headers;
    if (context?.[SPAN] && headers && typeof headers === 'object') {
      Object.defineProperty(headers, SKIP_HTTP, { value: true, enumerable: false, configurable: true });
    }
  } catch {
    // ignore
  }
  return next(args);
};

const instrumentedStacks = new WeakSet<object>();

/** Patches `Client.prototype.send` of one smithy-client copy so every client adds our middleware once. */
export function patchSmithyClient(tracer: Tracer, exports: any): void {
  const Client = exports?.Client;
  const proto = Client?.prototype;
  if (!proto || typeof proto.send !== 'function' || proto[PATCHED]) return;
  const send = proto.send;
  proto.send = function (this: any, ...args: any[]) {
    try {
      const stack = this.middlewareStack;
      if (stack && !instrumentedStacks.has(stack)) {
        instrumentedStacks.add(stack);
        stack.add(tracingMiddleware(tracer, this), { step: 'initialize', priority: 'high', name: 'ivyTracingMiddleware', override: true });
        stack.add(markRequestMiddleware, { step: 'deserialize', priority: 'low', name: 'ivyMarkRequestMiddleware', override: true });
      }
    } catch {
      // never break the SDK
    }
    return send.apply(this, args);
  };
  Object.defineProperty(proto, PATCHED, { value: true });
}

/**
 * Hooks CommonJS loading so every copy of the smithy client (runtime-provided or user-installed,
 * whether reached via require or via an ESM import of a CJS client) is patched when first loaded.
 */
export function instrumentAwsSdk(tracer: Tracer): void {
  onRequire((request, exports) => {
    if (CLIENT_MODULES.has(request)) patchSmithyClient(tracer, exports);
  });
  const cache: Record<string, { exports?: unknown } | undefined> = (process.getBuiltinModule('node:module') as any)._cache ?? {};
  for (const key of Object.keys(cache)) {
    if (/[\\/]@(smithy|aws-sdk)[\\/](core[\\/]dist-cjs[\\/]submodules[\\/]client|smithy-client[\\/]dist-cjs)[\\/]/.test(key)) {
      patchSmithyClient(tracer, cache[key]?.exports);
    }
  }
}
