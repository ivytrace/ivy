import { cleanStack } from './span.js';
import type { Invocation, LambdaContext, Tracer } from './tracer.js';

type Handler = (event: unknown, context: any, callback?: (err?: unknown, result?: unknown) => void) => unknown;

function stripLayerFrames(err: unknown): void {
  try {
    if (err instanceof Error && typeof err.stack === 'string') {
      const cleaned = cleanStack(err.stack);
      if (cleaned !== err.stack) err.stack = cleaned;
    }
  } catch {
    // stack is cosmetic
  }
}

const isPromise = (v: unknown): v is Promise<unknown> => !!v && typeof (v as any).then === 'function';

/**
 * Wraps a user handler. Results, errors and callback semantics are passed through unchanged;
 * the wrapper keeps the user's arity and async-ness, which the runtime inspects.
 */
export function wrapHandler(tracer: Tracer, user: Handler): Handler {
  const run = (event: unknown, context: LambdaContext, callback?: (err?: unknown, result?: unknown) => void): unknown => {
    let inv: Invocation | undefined;
    try {
      inv = tracer.startInvocation(event, context ?? {});
    } catch {
      inv = undefined;
    }
    if (!inv) return user(event, context, callback);
    const invocation = inv;
    const finish = (err: unknown, result?: unknown) => {
      try {
        tracer.endInvocation(invocation, err, result);
      } catch {
        // never affect the function
      }
    };

    const cb =
      typeof callback === 'function'
        ? (err?: unknown, result?: unknown) => {
            finish(err ?? null, result);
            if (err) stripLayerFrames(err);
            return callback(err, result);
          }
        : callback;

    let ret: unknown;
    try {
      ret = user(event, context, cb);
    } catch (err) {
      finish(err);
      stripLayerFrames(err);
      throw err;
    }
    if (isPromise(ret)) {
      return ret.then(
        (result) => {
          finish(null, result);
          return result;
        },
        (err) => {
          finish(err ?? new Error('Promise rejected without a reason'));
          stripLayerFrames(err);
          throw err;
        },
      );
    }
    return ret;
  };

  const isAsync = user.constructor?.name === 'AsyncFunction';
  const wrapped: Handler = isAsync
    ? async (event, context, callback) => run(event, context, callback)
    : (event, context, callback) => run(event, context, callback);
  try {
    Object.defineProperty(wrapped, 'length', { value: user.length });
    Object.defineProperty(wrapped, 'name', { value: user.name || 'handler' });
  } catch {
    // ignore
  }
  return wrapped;
}
