import { describe, expect, it } from "vitest";
import { formatDuration, formatPercent } from "./format";

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(0.5)).toBe("0.50 ms");
    expect(formatDuration(9.25)).toBe("9.3 ms");
    expect(formatDuration(93.2)).toBe("93 ms");
    expect(formatDuration(1520)).toBe("1.52 s");
    expect(formatDuration(90_000)).toBe("1.5 min");
  });

  it("formats percentages", () => {
    expect(formatPercent(0.0097)).toBe("0.97%");
    expect(formatPercent(0.125)).toBe("12.5%");
  });
});
