import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { ErrorGroup } from "@/lib/api/types";
import { ErrorTemplate, GroupMessage, GroupMessages, variantsLabel } from "./error-template";

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
const scope = { workspace: "acme", project: "checkout-prod" };

const group: ErrorGroup = {
  fingerprint: "a1b2c3d4e5f60718",
  function: "uploads-get",
  error_type: "Error",
  error_message: "Upload not found for ID: favicon.ico",
  error_template: "Upload not found for ID: {path}",
  count: 52,
  variants: 23,
  top_messages: [
    { message: "Upload not found for ID: fonts/mono-regular.woff", count: 9, sample_trace_id: "6af84d409a1b2c3d4e5f60718293a4b5", last_seen: "2026-11-14T12:00:00.000Z" },
    { message: "Upload not found for ID: favicon.ico", count: 3, sample_trace_id: "6af84d4577aa88bb99cc00dd11ee22ff", last_seen: "2026-11-14T11:00:00.000Z" },
  ],
  first_seen: "2026-11-14T08:00:00.000Z",
  last_seen: "2026-11-14T12:00:00.000Z",
  sample_trace_id: "6af84d409a1b2c3d4e5f60718293a4b5",
  kind: "error",
  failure_kind: null,
};

describe("GroupMessage", () => {
  it("shows the template when the group has several messages", () => {
    expect(text(renderToStaticMarkup(<GroupMessage group={group} />))).toBe("Upload not found for ID: {path}");
  });

  it("shows the message itself when every occurrence has the same one", () => {
    const one = { ...group, variants: 1, error_message: "flushed 100ms before the deadline", error_template: "flushed {num}ms before the deadline" };
    expect(text(renderToStaticMarkup(<GroupMessage group={one} />))).toBe("flushed 100ms before the deadline");
  });
});

describe("ErrorTemplate", () => {
  it("mutes the placeholders and keeps the text", () => {
    const html = renderToStaticMarkup(<ErrorTemplate template="Upload not found for ID: {path} ({num})" />);
    expect(text(html)).toBe("Upload not found for ID: {path} ({num})");
    expect(html).toContain('<span class="font-mono text-[0.9em] text-zinc-500">{path}</span>');
    expect(html).toContain('<span class="font-mono text-[0.9em] text-zinc-500">{num}</span>');
    expect(html).not.toContain('text-zinc-500">Upload');
  });

  it("leaves a message without placeholders as it is", () => {
    const html = renderToStaticMarkup(<ErrorTemplate template="Cannot read properties of undefined (reading 'id')" />);
    expect(text(html)).toBe("Cannot read properties of undefined (reading 'id')");
    expect(html).not.toContain("text-zinc-500");
  });
});

describe("GroupMessages", () => {
  it("lists the most frequent messages with their counts, each linking to its trace", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <GroupMessages group={group} scope={scope} />
      </MemoryRouter>,
    );
    expect(text(html)).toContain("9×Upload not found for ID: fonts/mono-regular.woff");
    expect(text(html)).toContain("3×Upload not found for ID: favicon.ico");
    expect(html).toContain('href="/w/acme/checkout-prod/traces/6af84d409a1b2c3d4e5f60718293a4b5"');
    expect(html).toContain('href="/w/acme/checkout-prod/traces/6af84d4577aa88bb99cc00dd11ee22ff"');
    expect(text(html)).toContain("The 2 most frequent of 23 variants.");
  });

  it("says nothing more when every variant is shown", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <GroupMessages group={{ ...group, variants: 2 }} scope={scope} />
      </MemoryRouter>,
    );
    expect(text(html)).not.toContain("most frequent");
  });

  it("labels variant counts", () => {
    expect(variantsLabel(1)).toBe("1 variant");
    expect(variantsLabel(1234)).toBe("1,234 variants");
  });
});
