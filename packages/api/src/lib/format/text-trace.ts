import { formatTrace, type Detail } from '@ivy/format';
import type { Trace } from '@ivy/spans';
import type { Context } from 'hono';
import { badRequest } from '../utils/http-error.js';

const DETAILS: Detail[] = ['summary', 'normal', 'full'];

/** JSON, or with `?format=text` an LLM-friendly text tree (`detail`, `max_tokens`). */
export function traceResponse(c: Context, trace: Trace) {
  return c.req.query('format') === 'text' ? textTrace(c, trace) : c.json(trace);
}

function textTrace(c: Context, trace: Trace) {
  const { detail = 'normal', max_tokens: maxTokens = '4000' } = c.req.query();
  if (!DETAILS.includes(detail as Detail)) throw badRequest(`Invalid detail: ${detail}`);
  const budget = Number(maxTokens);
  if (!Number.isInteger(budget) || budget < 0) throw badRequest(`Invalid max_tokens: ${maxTokens}`);
  return c.text(formatTrace(trace, { detail: detail as Detail, maxTokens: budget }));
}
