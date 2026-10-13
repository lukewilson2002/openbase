/** The contract tests' own helpers must be right, or a green run means nothing. */
import { describe, expect, it } from "vitest";
import { createCookieJar } from "./cookieJar";
import { base32Decode, hotp, totp } from "./totp";
import { parse, parseList, problemsFor } from "./typecheck";

describe("totp", () => {
  const rfcSecret = Buffer.from("12345678901234567890");

  it("matches the RFC 6238 SHA-1 test vectors (8 digits)", () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ];
    for (const [time, code] of vectors) expect(hotp(rfcSecret, Math.floor(time / 30), 8)).toBe(code);
  });

  it("decodes base32 and produces 6-digit codes", () => {
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").toString()).toBe("12345678901234567890");
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59)).toBe("287082");
    expect(() => base32Decode("not base32!")).toThrow();
  });
});

describe("typecheck against the generated bindings", () => {
  const user = { id: "usr1", email: "a@example.test", name: "A", is_admin: false, totp_enabled: false };

  it("accepts a conforming value, with optional keys absent or null", () => {
    expect(parse("User", user)).toEqual(user);
    expect(parse("User", { ...user, timezone: null })).toBeTruthy();
    expect(parse("User", { ...user, timezone: "Europe/Berlin" })).toBeTruthy();
    expect(parse("OkResponse", { ok: true })).toEqual({ ok: true });
  });

  it("reports missing required fields, wrong types and unknown fields", () => {
    const { name: _name, ...noName } = user;
    expect(problemsFor("User", noName)).toEqual(["User.name: required field is missing"]);
    expect(problemsFor("User", { ...user, is_admin: "yes" })).toEqual(["User.is_admin: expected boolean, got string"]);
    expect(problemsFor("User", { ...user, surprise: 1 })).toEqual(["User.surprise: unknown field (not in the generated type)"]);
    expect(problemsFor("User", { ...user, timezone: 5 })[0]).toContain("User.timezone");
    expect(() => parse("User", [])).toThrow(/expected object/);
  });

  it("follows nested references, arrays and optional-nullable fields", () => {
    const entry = { id: 3, action: "login", created_at: 1 };
    expect(parse("AuditPage", { entries: [entry, { ...entry, id: 2, detail: { a: [1, "x", null] }, ip: null }], next_before: 2 }).entries).toHaveLength(2);
    expect(parse("AuditPage", { entries: [] }).entries).toEqual([]);
    expect(problemsFor("AuditPage", { entries: [{ ...entry, id: "3" }] })[0]).toContain("AuditPage.entries[0].id: expected number");
    expect(problemsFor("AuditPage", { entries: {} })[0]).toContain("expected array");
    expect(parseList("SessionInfo", [])).toEqual([]);
    expect(() => parseList("SessionInfo", {})).toThrow(/JSON array/);
  });

  it("rejects the response shapes the web client used to guess at", () => {
    // `{user}` wrapper instead of the bare user, and a wrapped list instead of an array.
    expect(problemsFor("User", { user })[0]).toContain("required field is missing");
    expect(() => parseList("TokenInfo", { tokens: [] })).toThrow();
  });
});

describe("cookie jar", () => {
  it("starts empty and remembers its client address", () => {
    const jar = createCookieJar("10.9.9.9");
    expect(jar.cookies.size).toBe(0);
    expect(jar.ip).toBe("10.9.9.9");
  });
});
