import { describe, expect, it } from "vitest";
import { CUT_KEY, CUT_VALUE, repairTruncatedJson } from "./repair-json.js";

const cut = { [CUT_KEY]: CUT_VALUE };

describe("repairTruncatedJson", () => {
  it("closes a string cut mid-way", () => {
    expect(repairTruncatedJson('{"a":1,"b":"hel')).toEqual({ a: 1, b: "hel…", ...cut });
  });

  it("drops a dangling key, with or without its colon", () => {
    expect(repairTruncatedJson('{"a":1,"b')).toEqual({ a: 1, ...cut });
    expect(repairTruncatedJson('{"a":1,"b"')).toEqual({ a: 1, ...cut });
    expect(repairTruncatedJson('{"a":1,"b": ')).toEqual({ a: 1, ...cut });
  });

  it("stops after a comma", () => {
    expect(repairTruncatedJson('{"a":1,')).toEqual({ a: 1, ...cut });
    expect(repairTruncatedJson("[1, 2, ")).toEqual([1, 2, CUT_VALUE]);
  });

  it("drops a partial number or literal", () => {
    expect(repairTruncatedJson('{"a":"x","n":12')).toEqual({ a: "x", ...cut });
    expect(repairTruncatedJson('[true,fal')).toEqual([true, CUT_VALUE]);
    expect(repairTruncatedJson('[1,2.5e')).toEqual([1, CUT_VALUE]);
  });

  it("marks every open container in nested arrays and objects", () => {
    expect(repairTruncatedJson('{"a":[[1,2],[3,')).toEqual({ a: [[1, 2], [3, CUT_VALUE], CUT_VALUE], ...cut });
    expect(repairTruncatedJson('[{"x":{"y":"z"},"w":[')).toEqual([{ x: { y: "z" }, w: [CUT_VALUE], ...cut }, CUT_VALUE]);
  });

  it("handles escape sequences and a cut inside one", () => {
    expect(repairTruncatedJson('{"a":"q\\"x\\n","b":"tab\\')).toEqual({ a: 'q"x\n', b: "tab…", ...cut });
    expect(repairTruncatedJson('{"a":"\\u00e9t\\u00')).toEqual({ a: "ét…", ...cut });
    expect(repairTruncatedJson('{"a":"x","b":"\\u')).toEqual({ a: "x", b: "…", ...cut });
    expect(repairTruncatedJson('{"a":"x","b":"smile \\ud83d')).toEqual({ a: "x", b: "smile …", ...cut });
  });

  it("keeps a body that is itself a JSON string", () => {
    const event = { headers: { host: "api.example.com" }, body: JSON.stringify({ order: "checkout", items: [1, 2] }) };
    const text = JSON.stringify(event);
    const repaired = repairTruncatedJson(text.slice(0, text.indexOf("items") + 3)) as Record<string, unknown>;
    expect(repaired.headers).toEqual({ host: "api.example.com" });
    expect(repaired.body).toBe('{"order":"checkout","ite…');
    expect(repaired[CUT_KEY]).toBe(CUT_VALUE);
  });

  it("keeps a __proto__ key as data", () => {
    const repaired = repairTruncatedJson('{"__proto__":{"x":1},"a":"b') as Record<string, unknown>;
    expect(Object.getPrototypeOf(repaired)).toBe(Object.prototype);
    expect(Object.keys(repaired)).toEqual(["__proto__", "a", CUT_KEY]);
  });

  it("gives up on text that is not cut JSON or recovers nothing", () => {
    expect(repairTruncatedJson('{"a":1}')).toBeUndefined();
    expect(repairTruncatedJson("plain text")).toBeUndefined();
    expect(repairTruncatedJson('"just a string')).toBeUndefined();
    expect(repairTruncatedJson('{"a":1 x')).toBeUndefined();
    expect(repairTruncatedJson('{"a":"\\q')).toBeUndefined();
    expect(repairTruncatedJson('{"ab')).toBeUndefined();
    expect(repairTruncatedJson("")).toBeUndefined();
  });
});
