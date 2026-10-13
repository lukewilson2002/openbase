import { describe, expect, it } from "vitest";
import { publicLink, publicPath, sharePasswordProblem } from "./shareLinks";

describe("share link addresses", () => {
  it("uses /share for read-only views and /form for forms", () => {
    expect(publicPath("view", "abc")).toBe("/share/abc");
    expect(publicPath("form", "abc")).toBe("/form/abc");
    expect(publicPath("view", "a/b c")).toBe("/share/a%2Fb%20c");
  });

  it("prefers the server's configured public address over the page's origin", () => {
    const link = { kind: "view" as const, token: "tok", url: "https://base.example.com/s/tok" };
    expect(publicLink(link, "http://192.168.1.5:8080")).toBe("https://base.example.com/share/tok");
    expect(publicLink({ ...link, kind: "form" }, "http://x")).toBe("https://base.example.com/form/tok");
    expect(publicLink({ ...link, url: "/s/tok" }, "http://localhost:5173")).toBe("http://localhost:5173/share/tok");
  });

  it("checks the password length like the server", () => {
    expect(sharePasswordProblem("abc")).toMatch(/at least 4/);
    expect(sharePasswordProblem("abcd")).toBeNull();
    expect(sharePasswordProblem("x".repeat(257))).toMatch(/at most 256/);
  });
});
