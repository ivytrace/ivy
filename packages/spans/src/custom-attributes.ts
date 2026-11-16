import type { Span } from "./types.js";

/**
 * Namespaces of the attributes the layer, the extension and the server set on the invocation span. The
 * layer refuses user attributes in them (`packages/layer/src/lib/otel-bridge/invocation-span.ts`), so
 * everything else on an invocation span was set by the app, e.g. `trace.getActiveSpan()?.setAttribute("user.id", id)`.
 */
const RESERVED = /^(ivy|faas|cloud|aws|http|url|messaging|error|exception|otel)\./;

/** The app's own attributes on an invocation span, sorted by key. */
export function customAttributes(span: Span): [string, string][] {
  return Object.entries(span.attributes)
    .filter(([key]) => !RESERVED.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
}
