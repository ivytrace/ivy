import { invocationResources } from "./failures.js";
import type { Span } from "./types.js";

export type LambdaArch = "x86_64" | "arm64";

/** AWS list prices (us-east-1, first tier), in USD. */
export const LAMBDA_PRICES = {
  perGbSecond: { x86_64: 0.0000166667, arm64: 0.0000133334 },
  perRequest: 0.0000002,
} as const;

export interface InvocationCost {
  usd: number;
  arch: LambdaArch;
  /** False when the trace doesn't say which architecture ran it and x86_64 was assumed. */
  archKnown: boolean;
  memoryMb: number;
  billedMs: number;
  perGbSecond: number;
}

/** `host.arch` as the layer sets it (OpenTelemetry values, `amd64` | `arm64`). */
export function lambdaArch(resource: Record<string, string>): LambdaArch | null {
  const arch = resource["host.arch"];
  if (arch === "arm64") return "arm64";
  if (arch === "amd64" || arch === "x86_64") return "x86_64";
  return null;
}

/** Estimated compute + request cost of one invocation, from its billed duration and configured memory. */
export function invocationCost(span: Span): InvocationCost | null {
  const { billedDurationMs, memoryLimitMb } = invocationResources(span);
  if (billedDurationMs === null || memoryLimitMb === null) return null;
  const known = lambdaArch(span.resource);
  const arch = known ?? "x86_64";
  const perGbSecond = LAMBDA_PRICES.perGbSecond[arch];
  const gbSeconds = (memoryLimitMb / 1024) * (billedDurationMs / 1000);
  return {
    usd: gbSeconds * perGbSecond + LAMBDA_PRICES.perRequest,
    arch,
    archKnown: known !== null,
    memoryMb: memoryLimitMb,
    billedMs: billedDurationMs,
    perGbSecond,
  };
}

/** Two significant digits below a cent, cents above: `$0.0000052`, `$0.030`, `$1.25`, `$31,000`. */
export function formatUsd(usd: number): string {
  const digits = usd >= 100 ? 0 : 2;
  const options: Intl.NumberFormatOptions =
    usd >= 1 ? { minimumFractionDigits: digits, maximumFractionDigits: digits } : { minimumSignificantDigits: 2, maximumSignificantDigits: 2 };
  return `$${usd.toLocaleString("en-US", options)}`;
}
