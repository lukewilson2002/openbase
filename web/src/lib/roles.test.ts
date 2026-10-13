import { describe, expect, it } from "vitest";
import { atLeast, grantableRoles, isRole } from "./roles";
import { safeNext } from "./format";
import { validatePasswords } from "./password";

describe("roles", () => {
  it("orders viewer < commenter < editor < creator < owner", () => {
    expect(atLeast("owner", "creator")).toBe(true);
    expect(atLeast("creator", "creator")).toBe(true);
    expect(atLeast("editor", "creator")).toBe(false);
    expect(atLeast("viewer", "viewer")).toBe(true);
  });
  it("gives unknown or missing roles no access", () => {
    expect(atLeast(undefined, "viewer")).toBe(false);
    expect(atLeast(null, "viewer")).toBe(false);
    expect(atLeast("superuser", "viewer")).toBe(false);
    expect(isRole("owner")).toBe(true);
    expect(isRole("root")).toBe(false);
  });
  it("never lets a role grant more than it has", () => {
    expect(grantableRoles("editor")).toEqual(["viewer", "commenter", "editor"]);
    expect(grantableRoles("owner")).toHaveLength(5);
    expect(grantableRoles(null)).toEqual([]);
  });
});

describe("safeNext", () => {
  it("only allows same-origin paths", () => {
    expect(safeNext("/base/app1")).toBe("/base/app1");
    expect(safeNext("/invite/x?y=1")).toBe("/invite/x?y=1");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
  });
});

describe("validatePasswords", () => {
  it("checks length and confirmation", () => {
    expect(validatePasswords("too short", "too short")).toMatch(/at least 10/);
    expect(validatePasswords("longenough1", "different1")).toMatch(/do not match/);
    expect(validatePasswords("longenough1", "longenough1")).toBeNull();
  });
});
