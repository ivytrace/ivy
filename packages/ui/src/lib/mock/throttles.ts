import { NOW } from "./fixtures.ts";

/** Per-function, per-minute Lambda throttle counts, like the API's function_throttles table. */
export interface MockThrottle {
  function: string;
  region: string;
  minute: number;
  throttles: number;
}

const MINUTE = 60_000;

/** A burst of `minutes` throttled minutes ending `endAgoMs` before now, peaking in the middle. */
function burst(fn: string, region: string, endAgoMs: number, minutes: number, peak: number): MockThrottle[] {
  const end = Math.floor((NOW - endAgoMs) / MINUTE) * MINUTE;
  return Array.from({ length: minutes }, (_, i) => {
    const shape = 1 - Math.abs(i - (minutes - 1) / 2) / minutes;
    return { function: fn, region, minute: end - (minutes - 1 - i) * MINUTE, throttles: Math.max(1, Math.round(peak * shape)) };
  });
}

export const THROTTLES: MockThrottle[] = [
  ...burst("orders-processQueue", "eu-west-1", 35 * MINUTE, 12, 9),
  ...burst("orders-processQueue", "eu-west-1", 6 * 60 * MINUTE, 20, 14),
  ...burst("orders-processQueue", "eu-west-1", 3 * 86_400_000, 30, 20),
  ...burst("checkout-createOrder", "eu-west-1", 2 * 60 * MINUTE, 4, 3),
];

export const THROTTLED_MESSAGE =
  "Lambda rejected these invocations (concurrency limit); they never reached the function, so there is no trace.";
