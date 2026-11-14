import type { AttrValue, Attributes, Span } from '../tracer/span.js';
import { capString, REDACTED, redactText, serialize, type Capped, type KeyMatcher } from '../utils/redact.js';
import type { OtelAttributeValue, OtelAttributes } from './api.js';

/** OTel attribute value → Ivy attribute value (arrays keep their element types; OTLP encodes them as is). */
export function toAttrValue(value: OtelAttributeValue | undefined): AttrValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined) as string[];
  return undefined;
}

export function setAttributes(target: Attributes, attributes: OtelAttributes | undefined): void {
  if (!attributes) return;
  for (const key in attributes) {
    const v = toAttrValue(attributes[key]);
    if (v !== undefined) target[key] = v;
  }
}

/** JSON-looking strings are parsed so keys can be redacted at any depth, then re-serialized and capped. */
function capJsonOrText(text: string, maxBytes: number, isSecret: KeyMatcher): Capped {
  const first = text.charCodeAt(0);
  if ((first === 123 /* { */ || first === 91) /* [ */ && text.length <= 1024 * 1024) {
    try {
      return serialize(JSON.parse(text), maxBytes, isSecret);
    } catch {
      return capString(redactText(text, isSecret), maxBytes);
    }
  }
  return capString(text, maxBytes);
}

const lastSegment = (key: string) => key.slice(key.lastIndexOf('.') + 1);

/**
 * Applies the layer's payload rules to the attributes of a bridged span, at flush time (after the
 * response): string values whose own key matches `IVY_REDACT_KEYS` are redacted (numbers such as
 * token counts are kept), JSON strings are redacted by key at any depth, and every string is capped at
 * `maxBytes`. String arrays (e.g. `ai.prompt.tools`) get the same per element, within 4 × `maxBytes`.
 * Returns whether anything was truncated.
 */
export function capAttributes(span: Span, maxBytes: number, isSecret: KeyMatcher): boolean {
  let truncated = false;
  const attrs = span.attributes;
  for (const key in attrs) {
    const value = attrs[key];
    if (typeof value === 'string') {
      if (isSecret(lastSegment(key))) {
        attrs[key] = REDACTED;
        continue;
      }
      const capped = capJsonOrText(value, maxBytes, isSecret);
      attrs[key] = capped.text;
      truncated ||= capped.truncated;
    } else if (Array.isArray(value) && value.some((v) => typeof v === 'string')) {
      const out: string[] = [];
      let budget = maxBytes * 4;
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item !== 'string') {
          out.push(item);
          continue;
        }
        if (budget <= 0) {
          out.push(`…[truncated ${value.length - i} items]`);
          truncated = true;
          break;
        }
        const capped = capJsonOrText(item, Math.min(maxBytes, budget), isSecret);
        budget -= capped.text.length;
        truncated ||= capped.truncated;
        out.push(capped.text);
      }
      attrs[key] = out;
    }
  }
  for (const event of span.events) {
    for (const key in event.attributes) {
      const value = event.attributes[key];
      if (typeof value !== 'string') continue;
      const capped = capJsonOrText(value, maxBytes, isSecret);
      event.attributes[key] = capped.text;
      truncated ||= capped.truncated;
    }
  }
  return truncated;
}
