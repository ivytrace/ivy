import { describe, expect, it } from "vitest";
import { firstStep, suggestWorkspaceName, welcomeLink } from "./welcome";

describe("welcome wizard", () => {
  it("suggests a workspace name from a work email, else from the person", () => {
    expect(suggestWorkspaceName("erin@acme.io", "Erin Doe")).toBe("Acme");
    expect(suggestWorkspaceName("erin@eu.acme-labs.com", null)).toBe("Acme Labs");
    expect(suggestWorkspaceName("erin@acme.co.uk", null)).toBe("Acme");
    expect(suggestWorkspaceName("erin.doe@gmail.com", "Erin Doe")).toBe("Erin's workspace");
    expect(suggestWorkspaceName("erin.doe@gmail.com", null)).toBe("Erin's workspace");
    expect(suggestWorkspaceName(null, null)).toBe("My workspace");
  });

  it("keeps progress in the URL and skips the workspace step when it doesn't apply", () => {
    expect(welcomeLink("aws", { ws: "acme", project: "checkout-prod", account: undefined })).toBe("/welcome/aws?ws=acme&project=checkout-prod");
    expect(firstStep(true, false)).toBe("workspace");
    expect(firstStep(true, true)).toBe("project");
    expect(firstStep(false, false)).toBe("project");
  });
});
