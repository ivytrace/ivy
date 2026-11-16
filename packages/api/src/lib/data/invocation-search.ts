import { badRequest } from '../utils/http-error.js';

export interface AttributeTerm {
  key: string;
  value: string;
}

export interface InvocationSearch {
  /** Free text: request ID, trace ID, or a substring of the error message or HTTP path. */
  text: string;
  /** `key=value` terms: some span of the invocation has the attribute with exactly this (string) value. */
  attributes: AttributeTerm[];
}

const MAX_TERMS = 10;
const TERM = /(?<=^|\s)([A-Za-z_][\w.\-/:@]*)=("(?:[^"\\]|\\.)+"|[^\s"]+)(?=\s|$)/g;
/** Spans of an invocation start within its run: up to Lambda's 15-minute timeout after the invocation span. */
const RUN_MS = 15 * 60_000;
/** Clock slack between the invocation span and its children. */
const SLACK_MS = 60_000;

/** Splits a search query into `key=value` attribute terms (value optionally double-quoted) and the remaining free text. */
export function parseInvocationSearch(q: string | undefined): InvocationSearch {
  const attributes: AttributeTerm[] = [];
  const text = (q ?? '')
    .replace(TERM, (_, key: string, raw: string) => {
      const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
      attributes.push({ key, value });
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (attributes.length > MAX_TERMS) throw badRequest(`Too many key=value terms: up to ${MAX_TERMS}`);
  return { text, attributes };
}

/**
 * Trace IDs of the scope with, for every term, some span whose attribute matches, as a subquery on `otel_traces`
 * (bloom filter indexes on the attribute keys and values). One trace is one invocation: the layer doesn't
 * propagate trace context. Binds `attr_key_N` / `attr_value_N`; the caller binds `tenant`, `from` and `to`.
 */
export function attributeTraceIds(terms: AttributeTerm[], projectFilter: string) {
  const params: Record<string, string> = {};
  const conditions = terms.map((term, i) => {
    params[`attr_key_${i}`] = term.key;
    params[`attr_value_${i}`] = term.value;
    return `SpanAttributes[{attr_key_${i}:String}] = {attr_value_${i}:String}`;
  });
  const having = conditions.length > 1 ? `\n       GROUP BY TraceId HAVING ${conditions.map((c) => `max(${c})`).join(' AND ')}` : '';
  const sql = `SELECT ${having ? '' : 'DISTINCT '}TraceId FROM otel_traces
       WHERE TenantId = {tenant:String} ${projectFilter}
         AND Timestamp >= fromUnixTimestamp64Milli({from:Int64} - ${SLACK_MS})
         AND Timestamp < fromUnixTimestamp64Milli({to:Int64} + ${RUN_MS})
         AND (${conditions.join(' OR ')})${having}`;
  return { sql, params };
}
