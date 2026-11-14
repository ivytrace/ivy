import { describe, expect, it } from "vitest";
import { fanOut } from "./fan-out.js";

const ws = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `W${i}`, slug: `w${i}` }));

describe("fanOut", () => {
  it("bounds concurrency and keeps workspace order", async () => {
    let running = 0;
    let peak = 0;
    const result = await fanOut(
      ws(10),
      async (w) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return w.slug;
      },
      { concurrency: 3 },
    );
    expect(peak).toBe(3);
    expect(result.ok.map((r) => r.value)).toEqual(ws(10).map((w) => w.slug));
    expect(result.failed).toEqual([]);
  });

  it("collects failures and timeouts per workspace", async () => {
    const result = await fanOut(
      ws(3),
      async (w) => {
        if (w.id === "t1") throw new Error("boom");
        if (w.id === "t2") await new Promise((r) => setTimeout(r, 200));
        return 1;
      },
      { timeoutMs: 20 },
    );
    expect(result.ok.map((r) => r.workspace.id)).toEqual(["t0"]);
    expect(result.failed.map((f) => [f.workspace.id, f.error])).toEqual([
      ["t1", "boom"],
      ["t2", "timed out after 0.02s"],
    ]);
  });
});
