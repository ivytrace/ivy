import { describe, expect, it } from "vitest";
import { formatQueryResult, MAX_CELL_CHARS } from "./format-query.js";

const stats = { rows_read: 12345, bytes_read: 1, elapsed_ms: 87 };

describe("formatQueryResult", () => {
  it("prints a summary, the column names and one line per row", () => {
    const text = formatQueryResult({
      columns: [
        { name: "http_route", type: "String" },
        { name: "p95_ms", type: "Float64" },
        { name: "tags", type: "Map(String, String)" },
      ],
      rows: [
        ["/orders/{id}", 340, { a: "1" }],
        ["/carts|x\nnext", null, {}],
      ],
      truncated: false,
      stats,
    });
    expect(text).toBe(
      ["2 rows, read 12,345 rows in 87 ms", "http_route | p95_ms | tags", '/orders/{id} | 340 | {"a":"1"}', "/carts\\|x\\nnext | NULL | {}"].join("\n"),
    );
  });

  it("says when rows were cut off and shortens long cells", () => {
    const text = formatQueryResult({ columns: [{ name: "m", type: "String" }], rows: [["x".repeat(500)]], truncated: true, stats });
    expect(text.split("\n")[0]).toBe("1 row (truncated: add a LIMIT or aggregate), read 12,345 rows in 87 ms");
    expect(text.split("\n")[2]).toHaveLength(MAX_CELL_CHARS + 1);
  });
});
