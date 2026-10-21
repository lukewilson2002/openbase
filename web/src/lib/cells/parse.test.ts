import { describe, expect, it } from "vitest";
import { ALL_FIELDS, PEOPLE, field } from "@/test/fields";
import { displayShapeOf, isMultilineText } from "./kinds";
import { jsonEqual, linkNames, missingChoiceNames, parseText, parseTsv, toTsv, type ParseCtx } from "./parse";

const ctx: ParseCtx = { timeZone: "UTC", users: PEOPLE, linkIds: new Map([["alpha", "recA"], ["beta", "recB"]]) };
const parse = (type: keyof typeof ALL_FIELDS, text: string, c: ParseCtx = ctx) => {
  const r = parseText(ALL_FIELDS[type], text, c);
  return r.ok ? r.value : `ERR:${r.error}`;
};

describe("parseText per field type", () => {
  it("text", () => {
    expect(parse("text", " hello\nworld ")).toBe(" hello world ");
    expect(parse("text", "   ")).toBeNull();
    expect(parse("rich_text", "a\r\nb")).toBe("a\nb");
    expect(parse("barcode", "123")).toBe("123");
  });

  it("multiline text keeps its line breaks and is plain, like rich text", () => {
    const address = field("text", { multiline: true });
    expect(parseText(address, "12 High St\r\nSpringfield", ctx)).toEqual({ ok: true, value: "12 High St\nSpringfield" });
    expect(displayShapeOf(address)).toBe("multiline");
    expect(displayShapeOf(ALL_FIELDS.text)).toBe("text");
    expect(displayShapeOf(ALL_FIELDS.rich_text)).toBe("multiline");
    expect([address, ALL_FIELDS.rich_text, ALL_FIELDS.text].map(isMultilineText)).toEqual([true, true, false]);
  });

  it("numbers", () => {
    expect(parse("number", "$1,234.567")).toBe(1234.57);
    expect(parse("number", "")).toBeNull();
    expect(String(parse("number", "abc"))).toMatch(/^ERR:/);
    expect(parse("currency", "$1,200")).toBe(1200);
    expect(parse("currency", "(5.5)")).toBe(-5.5);
  });

  it("percent: plain numbers and % both mean percent, stored as a fraction", () => {
    expect(parse("percent", "50")).toBe(0.5);
    expect(parse("percent", "50%")).toBe(0.5);
    expect(parse("percent", "12.5%")).toBe(0.125);
  });

  it("rejects negatives when the field disallows them", () => {
    const f = field("number", { precision: 0, allow_negative: false });
    expect(parseText(f, "-3", ctx).ok).toBe(false);
    expect(parseText(f, "3", ctx)).toEqual({ ok: true, value: 3 });
  });

  it("duration", () => {
    expect(parse("duration", "1:30")).toBe(5400);
    expect(parse("duration", "1h 30m")).toBe(5400);
    expect(String(parse("duration", "soon"))).toMatch(/^ERR:/);
  });

  it("rating accepts numbers and stars and clamps to max", () => {
    expect(parse("rating", "3")).toBe(3);
    expect(parse("rating", "★★★★")).toBe(4);
    expect(parse("rating", "9")).toBe(5);
    expect(parse("rating", "0")).toBeNull();
    expect(String(parse("rating", "-1"))).toMatch(/^ERR:/);
  });

  it("checkbox", () => {
    expect(parse("checkbox", "checked")).toBe(true);
    expect(parse("checkbox", "yes")).toBe(true);
    expect(parse("checkbox", "no")).toBeNull();
    expect(String(parse("checkbox", "maybe"))).toMatch(/^ERR:/);
  });

  it("selects resolve names (case-insensitively) to ids and pass unknown names through", () => {
    expect(parse("single_select", "in progress")).toBe("chs2");
    expect(parse("single_select", "chs3")).toBe("chs3");
    expect(parse("single_select", "Brand new")).toBe("Brand new");
    expect(parse("multiple_select", "Todo, done, Mystery")).toEqual(["chs1", "chs3", "Mystery"]);
    expect(parse("multiple_select", '"Todo", todo')).toEqual(["chs1"]);
    expect(parse("multiple_select", "")).toBeNull();
  });

  it("dates parse many formats under the field options and zone", () => {
    expect(parse("date", "10/12/2026")).toBe("2026-10-12");
    expect(parse("date", "2026-10-12")).toBe("2026-10-12");
    expect(String(parse("date", "someday"))).toMatch(/^ERR:/);
    const eu = field("date", { include_time: false, date_format: "european", time_format: "h12", timezone: null });
    const r = parseText(eu, "12/10/2026", ctx);
    expect(r).toEqual({ ok: true, value: "2026-10-12" });
    // Created time is computed; last_modified_time too.
    expect(String(parse("created_time", "2026-10-12"))).toMatch(/^ERR:/);
    const dt = field("date", { include_time: true, date_format: "us", time_format: "h12", timezone: "Asia/Tokyo" });
    expect(parseText(dt, "10/12/2026 9:00am", ctx)).toEqual({ ok: true, value: "2026-10-12T00:00:00.000Z" });
  });

  it("email, url, phone", () => {
    expect(parse("email", " a@b.co ")).toBe("a@b.co");
    expect(String(parse("email", "nope"))).toMatch(/^ERR:/);
    expect(parse("url", "example.com")).toBe("https://example.com");
    expect(String(parse("url", "javascript:alert(1)"))).toMatch(/^ERR:/);
    expect(parse("phone", "+1 555 0100")).toBe("+1 555 0100");
    expect(String(parse("phone", "abc"))).toMatch(/^ERR:/);
  });

  it("attachments cannot come from text", () => {
    expect(parse("attachment", "")).toBeNull();
    expect(String(parse("attachment", "x.png"))).toMatch(/^ERR:/);
  });

  it("links resolve names to record ids", () => {
    expect(parse("link", "Alpha, beta")).toEqual(["recA", "recB"]);
    expect(parse("link", "recX1")).toEqual(["recX1"]);
    expect(String(parse("link", "Gamma"))).toMatch(/^ERR:/);
    const single = field("link", { linked_table_id: "t", inverse_field_id: "", single: true });
    expect(parseText(single, "Alpha, Beta", ctx).ok).toBe(false);
    expect(linkNames("Alpha, recX1, Beta")).toEqual(["Alpha", "Beta"]);
  });

  it("users resolve names and emails", () => {
    expect(parse("user", "Ada Lovelace")).toEqual(["usr1"]);
    expect(parse("user", "grace@example.com, ada@example.com")).toEqual(["usr2", "usr1"]);
    expect(String(parse("user", "Nobody"))).toMatch(/^ERR:/);
    const one = field("user", { multiple: false, notify: false });
    expect(parseText(one, "Ada Lovelace, Grace Hopper", ctx).ok).toBe(false);
  });

  it("computed fields are rejected", () => {
    for (const t of ["formula", "lookup", "rollup", "count", "created_time", "last_modified_time", "created_by", "last_modified_by", "autonumber", "button"] as const) {
      expect(parseText(ALL_FIELDS[t], "x", ctx).ok, t).toBe(false);
    }
  });

  it("lists the select names that would have to be created", () => {
    expect(missingChoiceNames(ALL_FIELDS.multiple_select, "Todo, New, new, Another")).toEqual(["New", "Another"]);
    expect(missingChoiceNames(ALL_FIELDS.single_select, "Done")).toEqual([]);
    expect(missingChoiceNames(ALL_FIELDS.number, "x")).toEqual([]);
  });
});

describe("TSV", () => {
  it("parses rows and cells", () => {
    expect(parseTsv("a\tb\nc\td")).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("ignores one trailing newline but keeps empty cells", () => {
    expect(parseTsv("a\t\tc\n")).toEqual([["a", "", "c"]]);
    expect(parseTsv("")).toEqual([]);
  });
  it("supports quoted cells with tabs, newlines and quotes", () => {
    expect(parseTsv('"a\tb"\t"line1\nline2"\t"say ""hi"""')).toEqual([["a\tb", "line1\nline2", 'say "hi"']]);
  });
  it("round-trips through toTsv", () => {
    const rows = [["plain", 'q"uote', "tab\there"], ["", "multi\nline", "x"]];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
  });
});

describe("jsonEqual", () => {
  it("treats null and undefined as the same empty value and compares deeply", () => {
    expect(jsonEqual(null, undefined)).toBe(true);
    expect(jsonEqual([{ id: "a" }], [{ id: "a" }])).toBe(true);
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEqual([1], [1, 2])).toBe(false);
    expect(jsonEqual("a", "b")).toBe(false);
    expect(jsonEqual(0, null)).toBe(false);
  });
});
