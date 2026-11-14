import { describe, expect, it } from "vitest";
import { markerCookie } from "./marker-cookie";
import { currentPath, loginPath, safeReturnTo } from "./return-to";

describe("safeReturnTo", () => {
  it("keeps paths on this origin, with query and hash", () => {
    expect(safeReturnTo("/invocations?function=checkout&status=error")).toBe(
      "/invocations?function=checkout&status=error",
    );
    expect(safeReturnTo("/traces/abc#logs")).toBe("/traces/abc#logs");
    expect(safeReturnTo("/")).toBe("/");
  });

  it("refuses anything that leaves the origin", () => {
    for (const value of [
      "https://evil.example.com/",
      "//evil.example.com",
      "/\\evil.example.com",
      "\\\\evil.example.com",
      "javascript:alert(1)",
      "functions",
      "",
      "/\nfoo",
      undefined,
      null,
      42,
    ]) {
      expect(safeReturnTo(value)).toBe("/");
    }
  });

  it("doesn't return to the auth routes", () => {
    expect(safeReturnTo("/login?returnTo=/x")).toBe("/");
    expect(safeReturnTo("/logout")).toBe("/");
    expect(safeReturnTo("/auth/callback?code=1&state=2")).toBe("/");
    expect(safeReturnTo("/auth/callback/")).toBe("/");
  });
});

describe("loginPath", () => {
  it("encodes the path to come back to", () => {
    expect(loginPath("/invocations?function=a&status=error")).toBe(
      "/login?returnTo=%2Finvocations%3Ffunction%3Da%26status%3Derror",
    );
    expect(new URLSearchParams(loginPath("/traces/abc#logs").split("?")[1]).get("returnTo")).toBe("/traces/abc#logs");
  });

  it("leaves returnTo out for the root and unsafe targets", () => {
    expect(loginPath("/")).toBe("/login");
    expect(loginPath("//evil.example.com")).toBe("/login");
  });

  it("round-trips the current location", () => {
    const path = currentPath({ pathname: "/errors", search: "?function=x", hash: "#top" });
    const returnTo = new URLSearchParams(loginPath(path).split("?")[1]).get("returnTo");
    expect(safeReturnTo(returnTo)).toBe("/errors?function=x#top");
  });
});

describe("markerCookie", () => {
  it("sets a non-sensitive routing hint", () => {
    expect(markerCookie(true, true)).toBe("ivy_session=1; Path=/; SameSite=Lax; Max-Age=2592000; Secure");
    expect(markerCookie(true, false)).toBe("ivy_session=1; Path=/; SameSite=Lax; Max-Age=2592000");
  });

  it("clears it on sign-out", () => {
    expect(markerCookie(false, true)).toBe("ivy_session=; Path=/; SameSite=Lax; Max-Age=0; Secure");
  });
});
