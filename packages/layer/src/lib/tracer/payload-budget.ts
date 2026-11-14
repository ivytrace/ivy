/**
 * Attributes that carry payloads: captured bodies, SDK input/output, headers, and LLM prompts,
 * messages, responses and tool data. They count against the per-invocation payload budget and are
 * what gets trimmed, never the span itself.
 */
export const PAYLOAD_KEY =
  /^(ivy\.payload\.|ivy\.http\.(request|response)\.headers$|ai\.prompt|ai\.response\.(text|object|toolCalls|reasoning)|ai\.toolCall\.(args|result)$|gen_ai\.(input|output)\.messages$|gen_ai\.system_instructions$|gen_ai\.tool\.(definitions|call\.arguments|call\.result)$)/;

export const isPayloadKey = (key: string) => PAYLOAD_KEY.test(key);

export const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

/** Bytes of payload attributes one invocation may export, spent in the order spans are offered. */
export class PayloadBudget {
  trimmedBytes = 0;
  trimmedPayloads = 0;

  constructor(public remaining: number) {}

  /** Spends `bytes` if they fit; otherwise records them as trimmed. */
  take(bytes: number): boolean {
    if (bytes <= this.remaining) {
      this.remaining -= bytes;
      return true;
    }
    this.trimmedBytes += bytes;
    this.trimmedPayloads++;
    return false;
  }
}
