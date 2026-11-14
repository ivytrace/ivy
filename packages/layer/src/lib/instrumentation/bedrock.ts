import { now } from '../tracer/clock.js';
import { recordError, type Attributes, type Span } from '../tracer/span.js';

/**
 * Amazon Bedrock Runtime model calls: OpenTelemetry GenAI attributes at capture time, so collapsing
 * (provider + model) and token sums work like for other LLM spans, and streamed responses assembled into
 * one response payload (see docs/implementation/llm-spans.md, "Amazon Bedrock").
 */

export const BEDROCK_SERVICE = 'BedrockRuntime';
const PATH_OPERATIONS: Record<string, string> = {
  invoke: 'InvokeModel',
  'invoke-with-response-stream': 'InvokeModelWithResponseStream',
  converse: 'Converse',
  'converse-stream': 'ConverseStream',
};
export const BEDROCK_OPERATIONS = new Set(Object.values(PATH_OPERATIONS));
export const isBedrockStream = (operation: string) => operation === 'InvokeModelWithResponseStream' || operation === 'ConverseStream';
export const isBedrockConverse = (operation: string) => operation.startsWith('Converse');

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (...values: unknown[]): number | undefined => {
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};
const first = (...values: unknown[]) => values.find((v) => v !== undefined && v !== null && v !== '');

/** Operation and model of a Bedrock Runtime HTTP request: `/model/{modelId}/invoke`, … */
export function bedrockFromPath(host: string, path: string): { operation: string; modelId: string } | undefined {
  if (!/^bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/i.test(host)) return undefined;
  const m = /^\/model\/([^/?#]+)\/(invoke|invoke-with-response-stream|converse|converse-stream)(?:[?#]|$)/.exec(path);
  if (!m) return undefined;
  let modelId = m[1];
  try {
    modelId = decodeURIComponent(modelId);
  } catch {
    // keep as is
  }
  return { operation: PATH_OPERATIONS[m[2]], modelId };
}

const decoder = new TextDecoder();

/** A JSON body as an object: SDK bodies are `Uint8Array`s or strings, Converse inputs plain objects. */
export function decodeJson(body: unknown): Record<string, any> | undefined {
  if (isRecord(body) && !(body instanceof Uint8Array)) return body;
  try {
    const text = typeof body === 'string' ? body : body instanceof Uint8Array && body.byteLength <= 1024 * 1024 ? decoder.decode(body) : undefined;
    const parsed = text === undefined ? undefined : JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `gen_ai.*` attributes from the request: system, operation, model and the main settings. */
export function bedrockRequestAttributes(modelId: string | undefined, body: Record<string, any> | undefined): Attributes {
  const attrs: Attributes = {
    'gen_ai.system': 'aws.bedrock',
    'gen_ai.operation.name': /embed/i.test(modelId ?? '') ? 'embeddings' : 'chat',
  };
  if (modelId) attrs['gen_ai.request.model'] = modelId;
  const b = body ?? {};
  const inf = isRecord(b.inferenceConfig) ? b.inferenceConfig : isRecord(b.textGenerationConfig) ? b.textGenerationConfig : {};
  const maxTokens = num(b.max_tokens, b.max_gen_len, b.max_new_tokens, b.max_completion_tokens, inf.maxTokens, inf.max_new_tokens, inf.maxTokenCount);
  const temperature = num(b.temperature, inf.temperature);
  const topP = num(b.top_p, b.p, inf.topP, inf.top_p);
  if (maxTokens !== undefined) attrs['gen_ai.request.max_tokens'] = maxTokens;
  if (temperature !== undefined) attrs['gen_ai.request.temperature'] = temperature;
  if (topP !== undefined) attrs['gen_ai.request.top_p'] = topP;
  return attrs;
}

function header(headers: unknown, name: string): unknown {
  if (!isRecord(headers)) return undefined;
  for (const k in headers) if (k.toLowerCase() === name) return headers[k];
  return undefined;
}

/** `gen_ai.*` usage, finish reason and response model from a response body (any model family) and headers. */
export function bedrockResponseAttributes(res: Record<string, any> | undefined, headers?: unknown): Attributes {
  const attrs: Attributes = {};
  const r = res ?? {};
  const usage = isRecord(r.usage) ? r.usage : {};
  const metrics = isRecord(r['amazon-bedrock-invocationMetrics']) ? r['amazon-bedrock-invocationMetrics'] : {};
  const billed = isRecord(r.meta?.billed_units) ? r.meta.billed_units : {};
  const results: unknown[] = Array.isArray(r.results) ? r.results : [];
  const resultTokens = results.reduce<number | undefined>((sum, x) => (isRecord(x) && num(x.tokenCount) !== undefined ? (sum ?? 0) + Number(x.tokenCount) : sum), undefined);
  const input = num(
    usage.input_tokens,
    usage.inputTokens,
    usage.prompt_tokens,
    r.prompt_token_count,
    billed.input_tokens,
    r.inputTextTokenCount,
    metrics.inputTokenCount,
    header(headers, 'x-amzn-bedrock-input-token-count'),
  );
  const output = num(
    usage.output_tokens,
    usage.outputTokens,
    usage.completion_tokens,
    r.generation_token_count,
    billed.output_tokens,
    resultTokens,
    metrics.outputTokenCount,
    header(headers, 'x-amzn-bedrock-output-token-count'),
  );
  if (input !== undefined) attrs['gen_ai.usage.input_tokens'] = input;
  if (output !== undefined) attrs['gen_ai.usage.output_tokens'] = output;
  const finish = first(
    r.stop_reason,
    r.stopReason,
    r.finish_reason,
    r.choices?.[0]?.finish_reason,
    r.outputs?.[0]?.stop_reason,
    r.generations?.[0]?.finish_reason,
    r.results?.[0]?.completionReason,
  );
  if (typeof finish === 'string') attrs['gen_ai.response.finish_reasons'] = [finish];
  if (typeof r.model === 'string' && r.model) attrs['gen_ai.response.model'] = r.model;
  if (typeof r.id === 'string' && r.id) attrs['gen_ai.response.id'] = r.id;
  return attrs;
}

// ---- streams -------------------------------------------------------------------------------

const MAX_TEXT = 256 * 1024;

/**
 * Builds one response out of the events of `InvokeModelWithResponseStream` (`{chunk: {bytes}}`, whose
 * JSON is the model family's stream event) or `ConverseStream` (`{contentBlockDelta}`, `{metadata}`, …):
 * Anthropic events give an Anthropic message, Converse/Nova events a Converse response, anything else
 * the concatenated text.
 */
export class StreamAssembler {
  firstChunkMs: number | undefined;
  private anthropic = false;
  private message: Record<string, any> = {};
  private blocks: Record<string, any>[] = [];
  private converse = false;
  private converseBlocks: Record<string, any>[] = [];
  private stopReason: string | undefined;
  private usage: Record<string, number> = {};
  private metrics: Record<string, any> | undefined;
  private text = '';

  add(event: unknown): void {
    if (!isRecord(event)) return;
    this.firstChunkMs ??= now();
    if (isRecord(event.chunk)) {
      const c = decodeJson(event.chunk.bytes);
      if (c) this.addChunk(c);
    } else {
      this.addConverse(event);
    }
  }

  private append(target: Record<string, any>, key: string, value: unknown) {
    if (typeof value !== 'string') return;
    const prev = typeof target[key] === 'string' ? target[key] : '';
    if (prev.length < MAX_TEXT) target[key] = prev + value;
  }

  private addChunk(c: Record<string, any>): void {
    if (isRecord(c['amazon-bedrock-invocationMetrics'])) this.metrics = c['amazon-bedrock-invocationMetrics'];
    switch (c.type) {
      case 'message_start':
        this.anthropic = true;
        if (isRecord(c.message)) {
          this.message = { id: c.message.id, model: c.message.model };
          const input = num(c.message.usage?.input_tokens);
          if (input !== undefined) this.usage.input_tokens = input;
        }
        return;
      case 'content_block_start':
        this.anthropic = true;
        this.blocks[c.index ?? this.blocks.length] = { ...(isRecord(c.content_block) ? c.content_block : { type: 'text', text: '' }) };
        return;
      case 'content_block_delta': {
        const block = (this.blocks[c.index ?? 0] ??= { type: 'text', text: '' });
        const d = c.delta ?? {};
        if (d.type === 'input_json_delta') this.append(block, 'partial', d.partial_json);
        else if (d.type === 'thinking_delta') this.append(block, 'thinking', d.thinking);
        else this.append(block, 'text', d.text);
        return;
      }
      case 'message_delta':
        if (typeof c.delta?.stop_reason === 'string') this.stopReason = c.delta.stop_reason;
        if (num(c.usage?.output_tokens) !== undefined) this.usage.output_tokens = Number(c.usage.output_tokens);
        return;
      case 'content_block_stop':
      case 'message_stop':
      case 'ping':
        return;
    }
    if (c.contentBlockDelta || c.contentBlockStart || c.messageStop || c.metadata || c.messageStart) {
      this.addConverse(c);
      return;
    }
    this.append(this, 'text', c.generation ?? c.outputText ?? c.completion ?? c.outputs?.[0]?.text ?? c.choices?.[0]?.delta?.content ?? (c.is_finished ? undefined : c.text));
    const stop = first(c.stop_reason, c.outputs?.[0]?.stop_reason, c.completionReason, c.finish_reason, c.choices?.[0]?.finish_reason);
    if (typeof stop === 'string') this.stopReason = stop;
    const input = num(c.prompt_token_count, c.inputTextTokenCount);
    const output = num(c.generation_token_count, c.totalOutputTextTokenCount);
    if (input !== undefined) this.usage.input_tokens = input;
    if (output !== undefined) this.usage.output_tokens = (this.usage.output_tokens ?? 0) + output;
  }

  private addConverse(e: Record<string, any>): void {
    this.converse = true;
    if (isRecord(e.contentBlockStart)) {
      const tool = e.contentBlockStart.start?.toolUse;
      this.converseBlocks[e.contentBlockStart.contentBlockIndex ?? this.converseBlocks.length] = isRecord(tool) ? { toolUse: { ...tool, input: '' } } : {};
    } else if (isRecord(e.contentBlockDelta)) {
      const i = e.contentBlockDelta.contentBlockIndex ?? 0;
      const block = (this.converseBlocks[i] ??= {});
      const d = e.contentBlockDelta.delta ?? {};
      if (isRecord(d.toolUse)) this.append((block.toolUse ??= { input: '' }), 'input', d.toolUse.input);
      else if (isRecord(d.reasoningContent)) this.append((block.reasoningContent ??= { reasoningText: {} }).reasoningText, 'text', d.reasoningContent.text);
      else this.append(block, 'text', d.text);
    } else if (isRecord(e.messageStop)) {
      if (typeof e.messageStop.stopReason === 'string') this.stopReason = e.messageStop.stopReason;
    } else if (isRecord(e.metadata)) {
      if (isRecord(e.metadata.usage)) {
        const { inputTokens, outputTokens } = e.metadata.usage;
        if (num(inputTokens) !== undefined) this.usage.input_tokens = Number(inputTokens);
        if (num(outputTokens) !== undefined) this.usage.output_tokens = Number(outputTokens);
      }
      if (isRecord(e.metadata.metrics)) this.metrics = e.metadata.metrics;
    }
  }

  /** The assembled response, in the family's non-streaming shape. */
  result(): Record<string, any> {
    const usage = { ...this.usage };
    if (this.anthropic) {
      const content = this.blocks.filter(Boolean).map(({ partial, ...b }) => {
        if (partial === undefined) return b;
        try {
          return { ...b, input: JSON.parse(partial) };
        } catch {
          return { ...b, input: partial };
        }
      });
      return { ...this.message, role: 'assistant', content, stop_reason: this.stopReason, usage, 'amazon-bedrock-invocationMetrics': this.metrics };
    }
    if (this.converse) {
      const content = this.converseBlocks.filter(Boolean).map((b) => {
        if (!isRecord(b.toolUse) || typeof b.toolUse.input !== 'string') return b;
        try {
          return { toolUse: { ...b.toolUse, input: JSON.parse(b.toolUse.input || '{}') } };
        } catch {
          return b;
        }
      });
      return {
        output: { message: { role: 'assistant', content } },
        stopReason: this.stopReason,
        usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
        metrics: this.metrics,
      };
    }
    return { role: 'assistant', content: [{ type: 'text', text: this.text }], stop_reason: this.stopReason, usage, 'amazon-bedrock-invocationMetrics': this.metrics };
  }
}

/**
 * Wraps a streamed response so the span ends when the app has read the stream: time to first chunk,
 * final usage (stream metadata, `amazon-bedrock-invocationMetrics`) and the assembled response.
 */
export function tapBedrockStream(span: Span, stream: AsyncIterable<unknown>): AsyncIterable<unknown> {
  const assembler = new StreamAssembler();
  let done = false;
  const end = (err?: unknown) => {
    if (done) return;
    done = true;
    try {
      span.endMs = now();
      if (err) recordError(span, err, span.endMs);
      const res = assembler.result();
      Object.assign(span.attributes, bedrockResponseAttributes(res));
      if (assembler.firstChunkMs !== undefined) {
        span.attributes['gen_ai.response.time_to_first_chunk'] = Math.round(assembler.firstChunkMs - span.startMs) / 1000;
      }
      span.payloads.push({ key: 'ivy.payload.response', value: res });
    } catch {
      // never break the app's stream
    }
  };
  return {
    [Symbol.asyncIterator]() {
      const it = stream[Symbol.asyncIterator]();
      return {
        async next(...args: [] | [unknown]) {
          try {
            const r = await it.next(...args);
            if (r.done) end();
            else {
              try {
                assembler.add(r.value);
              } catch {
                // ignore
              }
            }
            return r;
          } catch (err) {
            end(err);
            throw err;
          }
        },
        async return(value?: unknown) {
          end();
          return it.return ? it.return(value) : { done: true, value };
        },
        async throw(err?: unknown) {
          end(err);
          if (it.throw) return it.throw(err);
          throw err;
        },
      };
    },
  };
}
