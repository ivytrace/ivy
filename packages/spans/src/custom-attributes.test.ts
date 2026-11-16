import { describe, expect, it } from "vitest";
import { customAttributes } from "./custom-attributes.js";
import type { Span } from "./types.js";

const span = (attributes: Record<string, string>) => ({ attributes }) as Span;

describe("customAttributes", () => {
  it("returns the app's attributes, without the layer's own, sorted by key", () => {
    expect(
      customAttributes(
        span({
          "ivy.invocation": "true",
          "faas.coldstart": "false",
          "http.route": "/orders",
          "aws.events": "1",
          "tenant.id": "acme",
          "user.id": "u-42",
          "feature.flag": "true",
        }),
      ),
    ).toEqual([
      ["feature.flag", "true"],
      ["tenant.id", "acme"],
      ["user.id", "u-42"],
    ]);
  });
});
