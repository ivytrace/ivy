import { describe, expect, it } from "vitest";
import { errorTemplate, errorTemplateSql, templateInput, templateParts, TEMPLATE_MAX_CHARS } from "./error-template.js";
import { TEMPLATE_VECTORS } from "./error-template.vectors.js";

describe("errorTemplate", () => {
  it.each(TEMPLATE_VECTORS)("%s: %s", (type, message, template) => {
    expect(errorTemplate(message, type)).toBe(template);
  });

  it("collapses the production upload errors into one template", () => {
    const messages = [
      "Upload not found for ID: fonts/mono-regular.woff",
      "Upload not found for ID: favicon.ico",
      "Upload not found for ID: _code-highlighting.js",
      "Upload not found for ID: fonts/semibold.woff2",
    ];
    expect(new Set(messages.map((m) => errorTemplate(m, "Error")))).toEqual(new Set(["Upload not found for ID: {path}"]));
  });

  it("keeps messages apart that differ in more than a variable part", () => {
    expect(errorTemplate("Upload not found for ID: favicon.ico")).not.toBe(errorTemplate("Download failed for ID: favicon.ico"));
    expect(errorTemplate("Cannot read properties of undefined (reading 'id')")).not.toBe(
      errorTemplate("Cannot read properties of undefined (reading 'map')"),
    );
    expect(errorTemplate("Error: Cannot find module 'left-pad'", "Runtime.ImportModuleError")).not.toBe(
      errorTemplate("Error: Cannot find module 'mjml'", "Runtime.ImportModuleError"),
    );
  });

  it("cuts long messages before normalizing", () => {
    const long = `Bad input ${"x".repeat(500)} 42`;
    expect(templateInput(long)).toHaveLength(TEMPLATE_MAX_CHARS);
    expect(errorTemplate(long)).not.toContain("42");
  });
});

describe("errorTemplateSql", () => {
  it("nests one replaceRegexpAll per rule and keeps verbatim types apart", () => {
    const sql = errorTemplateSql("m", "t");
    expect(sql.startsWith("if(t IN ('Runtime.ImportModuleError', 'Runtime.HandlerNotFound'), ")).toBe(true);
    expect(sql).toContain("'\\\\1{num}\\\\2'");
    expect(sql).not.toContain("$1");
  });
});

describe("templateParts", () => {
  it("splits placeholders from text", () => {
    expect(templateParts("Upload not found for ID: {path} ({num}) {other}")).toEqual([
      { text: "Upload not found for ID: ", placeholder: false },
      { text: "{path}", placeholder: true },
      { text: " (", placeholder: false },
      { text: "{num}", placeholder: true },
      { text: ") {other}", placeholder: false },
    ]);
  });
});
