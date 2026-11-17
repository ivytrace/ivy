import { describe, expect, it } from "vitest";
import { completionsFor, referencedTables } from "./completion";

const labels = (sql: string, qualifier: string | null = null) => completionsFor(sql, qualifier).map((c) => c.label);

describe("query completions", () => {
  it("finds the tables a query reads", () => {
    expect(referencedTables("SELECT * FROM spans s JOIN invocations i ON s.trace_id = i.trace_id")).toEqual(["spans", "invocations"]);
    expect(referencedTables("select 1 from Logs")).toEqual(["logs"]);
    expect(referencedTables("SELECT * FROM ivy.otel_traces")).toEqual([]);
  });

  it("offers the columns of the tables in the query, then tables and functions", () => {
    const options = labels("SELECT  FROM logs");
    expect(options).toContain("message");
    expect(options).not.toContain("db_system");
    expect(options).toContain("spans");
    expect(options).toContain("quantile");
  });

  it("offers every table's columns once before a FROM is written", () => {
    const options = labels("SELECT ");
    expect(options).toContain("db_system");
    expect(options).toContain("cold_start");
    expect(options.filter((o) => o === "trace_id")).toHaveLength(1);
  });

  it("offers only the columns of the table before a dot", () => {
    expect(labels("SELECT invocations.", "invocations")).toContain("http_route");
    expect(labels("SELECT invocations.", "invocations")).not.toContain("spans");
    expect(labels("SELECT x.", "x")).toEqual([]);
  });
});
