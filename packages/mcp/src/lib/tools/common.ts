import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const since = (fallback: string) =>
  z
    .string()
    .regex(/^\d+[mhd]$/, "Use a relative range like 15m, 1h, 24h or 7d")
    .default(fallback)
    .describe(`How far back to look: a number plus m (minutes), h (hours) or d (days), e.g. 15m, 1h, 24h, 7d. Default ${fallback}.`);

export const functionName = z
  .string()
  .min(1)
  .optional()
  .describe("Exact Lambda function name, e.g. checkout-createOrder. Omit for all functions.");

export const limit = (fallback: number, max = 100) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Maximum number of results (1-${max}, default ${fallback}).`);

export const maxTokens = z
  .number()
  .int()
  .min(200)
  .max(20000)
  .default(2000)
  .describe("Approximate size budget of the answer in tokens (default 2000). Detail is shed to fit; failures are always kept.");

export const traceId = z
  .string()
  .regex(/^[0-9a-fA-F]{32}$/, "A trace ID is 32 hex characters")
  .describe("Trace ID (32 hex characters), as shown in invocation lists.");

export const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });

export const failure = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Runs a tool body and turns thrown errors into an MCP tool error the model can read. */
export async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    return failure(`Ivy query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
