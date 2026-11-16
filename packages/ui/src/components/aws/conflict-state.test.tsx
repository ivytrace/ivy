import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConflictSummary, forcedReason, ForceInstallNotice } from "./conflict-state";

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

describe("force install", () => {
  it("names the other tracer when the wrapper tells which one it is", () => {
    const notice = text(renderToStaticMarkup(<ForceInstallNotice fn={{ tracer: "Lumigo", wrapper: "/opt/lumigo_wrapper" }} />));
    expect(notice).toContain("Replace Lumigo's wrapper?");
    expect(notice).toContain("Lumigo will most likely stop tracing this function.");
    expect(notice).toContain("Ivy restores /opt/lumigo_wrapper if you stop tracing the function");
  });

  it("falls back to generic wording for an unknown wrapper", () => {
    const notice = text(renderToStaticMarkup(<ForceInstallNotice fn={{ tracer: null, wrapper: "/opt/acme-wrapper" }} />));
    expect(notice).toContain("Replace the other wrapper?");
    expect(notice).toContain("The other tracer will most likely stop tracing this function.");
    expect(notice).not.toContain("null");
  });

  it("explains a wrapper that was set back after a force install", () => {
    const summary = text(
      renderToStaticMarkup(<ConflictSummary fn={{ tracer: "Lumigo", wrapper: "/opt/lumigo_wrapper", conflict: "reapplied", reason: null }} />),
    );
    expect(summary).toContain("AWS_LAMBDA_EXEC_WRAPPER was set back to /opt/lumigo_wrapper (Lumigo) after Ivy replaced it.");
    expect(summary).toContain("usually Lumigo's own integration");
  });

  it("says which wrapper a traced function replaced", () => {
    expect(forcedReason({ tracer: null, wrapper: "/opt/acme-wrapper" })).toBe(
      "Force-installed: another tracer's wrapper (/opt/acme-wrapper) was replaced. Ivy restores it when it stops tracing this function.",
    );
  });
});
