import { describe, expect, it } from "vitest";
import { canonicalUrl, hrefFor, isSafeLink, isValidEmail, isValidPhone, joinList, parseBoolWord, parseDuration, parseNumber, splitList } from "./text";

const num = (s: string, sym?: string) => parseNumber(s, sym)?.value ?? null;

describe("parseNumber", () => {
  it("is lenient about separators and symbols", () => {
    expect(num("42")).toBe(42);
    expect(num("  -3.5 ")).toBe(-3.5);
    expect(num("1,234.50")).toBe(1234.5);
    expect(num("$1,234.50")).toBe(1234.5);
    expect(num("-$5")).toBe(-5);
    expect(num("(12.50)")).toBe(-12.5);
    expect(num("€ 9")).toBe(9);
    expect(num("1e3")).toBe(1000);
    expect(num("1 000")).toBe(1000);
    expect(num(".5")).toBe(0.5);
    expect(num("CHF 12", "CHF")).toBe(12);
  });
  it("flags percentages", () => {
    expect(parseNumber("50%")).toEqual({ value: 50, percent: true });
    expect(parseNumber("50")).toEqual({ value: 50, percent: false });
  });
  it.each(["", "abc", "1.2.3", "inf", "NaN", "Infinity", "-", "$", "%", "5%%", "1e999", "12abc", "0x10"])("rejects %j", (s) => {
    expect(num(s)).toBeNull();
  });
});

describe("parseDuration", () => {
  it.each([
    ["1:30", 5400],
    ["0:05", 300],
    ["1:30:15", 5415],
    ["0:00:01.5", 1.5],
    ["90", 90],
    ["1h 30m", 5400],
    ["90 min", 5400],
    ["1.5 hours", 5400],
    ["45s", 45],
    ["-1:00", -3600],
  ])("parses %s", (s, secs) => expect(parseDuration(s)).toBe(secs));
  it.each(["", "abc", "1:75", "1:2:3:4", "1:", "h"])("rejects %j", (s) => expect(parseDuration(s)).toBeNull());
});

describe("parseBoolWord", () => {
  it("reads checkbox words", () => {
    for (const t of ["true", "Yes", "x", "1", "checked", "✓"]) expect(parseBoolWord(t)).toBe(true);
    for (const f of ["false", "No", "0", "", "unchecked"]) expect(parseBoolWord(f)).toBe(false);
    expect(parseBoolWord("maybe")).toBeNull();
  });
});

describe("lists", () => {
  it("splits on commas, honouring quotes", () => {
    expect(splitList("a, b ,c")).toEqual(["a", "b", "c"]);
    expect(splitList('"a, b", c')).toEqual(["a, b", "c"]);
    expect(splitList('"say ""hi""", x')).toEqual(['say "hi"', "x"]);
    expect(splitList(" , ,")).toEqual([]);
  });
  it("joins and splits back to the same items", () => {
    const items = ["plain", "with, comma", ' lead', 'q"uote'];
    expect(splitList(joinList(items))).toEqual(items);
  });
});

describe("validators", () => {
  it("checks email and phone", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    for (const bad of ["a@b", "a b@c.com", "@c.com", "a@@c.com", "a@-c.com"]) expect(isValidEmail(bad)).toBe(false);
    expect(isValidPhone("+1 (555) 010-1234")).toBe(true);
    expect(isValidPhone("555 010 1234 ext 12")).toBe(true);
    expect(isValidPhone("call me")).toBe(false);
    expect(isValidPhone("12")).toBe(false);
  });

  it("only allows http, https and mailto URLs", () => {
    expect(canonicalUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(canonicalUrl("example.com/x")).toBe("https://example.com/x");
    expect(canonicalUrl("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(canonicalUrl("localhost:8080")).toBe("https://localhost:8080");
    expect(canonicalUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalUrl("data:text/html,hi")).toBeNull();
    expect(canonicalUrl("ftp://x.y")).toBeNull();
    expect(canonicalUrl("not a url")).toBeNull();
  });

  it("decides what a cell may open", () => {
    expect(isSafeLink("https://x.y")).toBe(true);
    expect(isSafeLink("mailto:a@b.co")).toBe(true);
    expect(isSafeLink("javascript:alert(1)")).toBe(false);
    expect(isSafeLink("example.com")).toBe(false);
    expect(hrefFor("email", "a@b.co")).toBe("mailto:a@b.co");
    expect(hrefFor("email", "nope")).toBeNull();
    expect(hrefFor("phone", "+1 555 0100")).toBe("tel:+15550100");
    expect(hrefFor("url", "javascript:alert(1)")).toBeNull();
  });
});
