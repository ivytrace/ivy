import { describe, expect, it } from "vitest";
import { buildServiceGraph } from "./graph.js";
import type { Span } from "./types.js";

const span = (id: string, parent: string, attributes: Record<string, string>, name = id): Span => ({
  span_id: id,
  parent_span_id: parent,
  name,
  kind: "CLIENT",
  service: "fn",
  start: "2026-11-14T12:00:00.000Z",
  end: "2026-11-14T12:00:00.010Z",
  duration_ms: 10,
  status_code: "OK",
  status_message: "",
  attributes,
  resource: {},
  events: [],
});

const ddb = { "rpc.system": "aws-api", "rpc.service": "DynamoDB", "rpc.method": "GetItem", "aws.dynamodb.table_names": '["t"]' };

describe("buildServiceGraph", () => {
  it("adds a trigger node and groups repeated calls", () => {
    const { nodes, edges } = buildServiceGraph([
      span("root", "", { "ivy.invocation": "true", "ivy.trigger.source": "aws:sqs" }, "worker"),
      span("a", "root", ddb),
      span("b", "root", ddb),
    ]);
    expect(nodes.map((n) => [n.label, n.icon, n.instances])).toEqual([
      ["worker", "lambda", 1],
      ["t", "dynamodb", 2],
      ["SQS", "sqs", 1],
    ]);
    expect(edges.map((e) => e.id).sort()).toEqual(
      ["fn:worker->aws|dynamodb|GetItem|t|", "trigger:aws:sqs->fn:worker"].sort(),
    );
  });

  it("counts the calls of a summary span", () => {
    const { nodes } = buildServiceGraph([
      span("root", "", { "ivy.invocation": "true", "ivy.trigger.source": "aws:sqs" }, "worker"),
      span("a", "root", ddb),
      span("s", "root", { ...ddb, "ivy.collapsed.count": "1184" }, "DynamoDB.GetItem × 1,184"),
    ]);
    expect(nodes.find((n) => n.icon === "dynamodb")?.instances).toBe(1185);
  });
});
