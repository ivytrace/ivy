import { describe, expect, it } from "vitest";
import { trimPayload } from "./trim.js";

describe("trimPayload", () => {
  it("returns undefined for empty payloads", () => {
    expect(trimPayload(undefined, 100)).toBeUndefined();
    expect(trimPayload("", 100)).toBeUndefined();
  });

  it("shrinks long arrays and strings structurally", () => {
    const raw = JSON.stringify({ items: Array.from({ length: 9 }, (_, i) => i), note: "x".repeat(300) });
    const text = trimPayload(raw, 1000)!;
    expect(text).toContain('"…+4 more"');
    expect(text).toContain(`"${"x".repeat(120)}…"`);
  });

  it("cuts to the budget and marks it", () => {
    expect(trimPayload(JSON.stringify({ a: "y".repeat(100) }), 20)).toBe('{"a":"yyyyyyyyyyyyyy…(+88 chars)');
  });

  it("keeps redaction markers and flags payloads cut at the source", () => {
    const raw = `${JSON.stringify({ password: "[redacted]", data: "abc" }).slice(0, 30)}…[truncated 512 bytes]`;
    expect(trimPayload(raw, 200)).toBe('{"password":"[redacted]","data [cut at source, 512 bytes dropped]');
  });
});
