import * as Import from "@ivy/format/import-fixtures";
import type { AiSpanSpec } from "./ai.ts";

/**
 * An import worker whose calls the tracer collapsed into summary spans, with spans omitted at the span
 * limit (data from @ivy/format's import fixture).
 */
export const IMPORT_FUNCTION = "checkout-importOrders";
/** Trace ID of the most recent import, so it can be opened directly. */
export const IMPORT_TRACE_ID = "ca11ab1e00000000000000000000a1b2";
export const IMPORT_TIMELINE_MS = Import.IMPORT_DURATION_MS;
export const importRootAttributes = Import.importRootAttributes;
export const importLogs = Import.importLogs;

export const importSpans: AiSpanSpec[] = Import.importSpans.map(({ id: _id, ...s }) => ({ ...s, kind: "CLIENT" }));
