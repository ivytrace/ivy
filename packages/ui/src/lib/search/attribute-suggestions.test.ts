import { describe, expect, it } from "vitest";
import { applyKey, suggestKeys, tokenAt } from "./attribute-suggestions";

const KEYS = ["rpc.service", "http.response.status_code", "http.request.method", "job.task", "job.id"];

describe("tokenAt", () => {
  it("finds the word around the caret", () => {
    expect(tokenAt("", 0)).toEqual({ start: 0, end: 0, text: "" });
    expect(tokenAt("timeout job.t", 13)).toEqual({ start: 8, end: 13, text: "job.t" });
    expect(tokenAt("job.t timeout", 3)).toEqual({ start: 0, end: 5, text: "job.t" });
    expect(tokenAt("timeout ", 8)).toEqual({ start: 8, end: 8, text: "" });
  });
});

describe("suggestKeys", () => {
  it("offers the most used keys for an empty word", () => {
    expect(suggestKeys(KEYS, "", 3)).toEqual(["rpc.service", "http.response.status_code", "http.request.method"]);
  });

  it("puts keys starting with the word before keys containing it", () => {
    expect(suggestKeys(KEYS, "job")).toEqual(["job.task", "job.id"]);
    expect(suggestKeys(KEYS, "S")).toEqual(["rpc.service", "http.response.status_code", "http.request.method", "job.task"]);
    expect(suggestKeys(KEYS, "status")).toEqual(["http.response.status_code"]);
  });

  it("offers nothing while a value is typed or for text that is no key", () => {
    expect(suggestKeys(KEYS, "job.task=")).toEqual([]);
    expect(suggestKeys(KEYS, "job.task=imp")).toEqual([]);
    expect(suggestKeys(KEYS, '"job')).toEqual([]);
    expect(suggestKeys(KEYS, "nothing-like-it")).toEqual([]);
  });
});

describe("applyKey", () => {
  it("replaces the word at the caret with key= and puts the caret after it", () => {
    expect(applyKey("", 0, "job.task")).toEqual({ value: "job.task=", caret: 9 });
    expect(applyKey("timeout jo", 10, "job.task")).toEqual({ value: "timeout job.task=", caret: 17 });
    expect(applyKey("jo timeout", 2, "job.id")).toEqual({ value: "job.id= timeout", caret: 7 });
  });
});
