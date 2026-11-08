import { describe, expect, it } from "vitest";
import { ALL_FIELDS, field, makeTable } from "@/test/fields";
import { foldLabel, hasValue, recordInitials, splitProperties, tileImage, titleModeOf } from "./properties";

const f = (id: string, name = id) => field("text", { multiline: false }, { id, name });
const png = { id: "att1", filename: "a.png", mime: "image/png", size: 1, width: 1, height: 1 };
const pdf = { id: "att2", filename: "a.pdf", mime: "application/pdf", size: 1, width: null, height: null };

describe("titleModeOf", () => {
  it("edits single-line text-like primaries in place", () => {
    for (const t of ["text", "number", "currency", "percent", "duration", "email", "url", "phone", "barcode"] as const) expect(titleModeOf(ALL_FIELDS[t]), t).toBe("inline");
  });

  it("leaves a computed primary as a plain heading", () => {
    for (const t of ["formula", "autonumber", "created_time", "last_modified_by"] as const) expect(titleModeOf(ALL_FIELDS[t]), t).toBe("readonly");
  });

  it("keeps a primary that needs an editor of its own as a row of the list", () => {
    for (const t of ["single_select", "date", "user", "rich_text"] as const) expect(titleModeOf(ALL_FIELDS[t]), t).toBe("row");
    expect(titleModeOf(field("text", { multiline: true }))).toBe("row");
  });

  it("is read-only when the collection has no primary property to find", () => {
    expect(titleModeOf(undefined)).toBe("readonly");
  });
});

describe("hasValue", () => {
  it("counts a number, a checked box and a list as values, and no text, an unchecked box or an empty list as none", () => {
    const text = ALL_FIELDS.text;
    expect(hasValue(text, "a")).toBe(true);
    expect(hasValue(ALL_FIELDS.number, 0)).toBe(true);
    expect(hasValue(ALL_FIELDS.checkbox, true)).toBe(true);
    expect(hasValue(ALL_FIELDS.multiple_select, ["chs1"])).toBe(true);
    for (const v of [null, undefined, "", false, []]) expect(hasValue(text, v)).toBe(false);
  });

  it("does not count a rating of 0", () => {
    expect(hasValue(ALL_FIELDS.rating, 0)).toBe(false);
    expect(hasValue(ALL_FIELDS.rating, 3)).toBe(true);
  });
});

describe("splitProperties", () => {
  const body = f("body", "Page");
  const table = makeTable([f("title"), f("a"), f("b"), f("c"), f("d"), body], { body_field_id: "body" });
  const base = { table, title: "inline" as const };

  it("lists the properties with a value in the default view's order, less the title and the Page", () => {
    const groups = splitProperties({ ...base, layout: { field_order: ["d", "c", "b", "a"], hidden_fields: [] }, values: { title: "T", a: "1", c: "3", d: "4", body: "text" } });
    expect(groups.shown.map((x) => x.id)).toEqual(["d", "c", "a"]);
    expect(groups.empty.map((x) => x.id)).toEqual(["b"]);
    expect(groups.hidden).toEqual([]);
  });

  it("puts the properties the default view hides in their own fold, whether or not they have a value", () => {
    const groups = splitProperties({ ...base, layout: { field_order: [], hidden_fields: ["a", "b", "body"] }, values: { a: "1", c: "3" } });
    expect(groups.hidden.map((x) => x.id)).toEqual(["a", "b"]);
    expect(groups.shown.map((x) => x.id)).toEqual(["c"]);
    expect(groups.empty.map((x) => x.id)).toEqual(["d"]);
  });

  it("falls back to the table's order when there is no default view", () => {
    const groups = splitProperties({ ...base, layout: undefined, values: { a: "1", b: "2", c: "3", d: "4" } });
    expect(groups.shown.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps a row the page already showed when its value is cleared", () => {
    const groups = splitProperties({ ...base, layout: undefined, values: { a: "" }, pinned: new Set(["a"]) });
    expect(groups.shown.map((x) => x.id)).toEqual(["a"]);
  });

  it("lists a title that is a row even when it is empty, and leaves out one that is edited in the head", () => {
    expect(splitProperties({ ...base, title: "row", layout: undefined, values: {} }).shown.map((x) => x.id)).toEqual(["title"]);
    expect(splitProperties({ ...base, layout: undefined, values: {} }).empty.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("never hides the title, even when the view lists it as hidden", () => {
    const groups = splitProperties({ ...base, title: "row", layout: { field_order: [], hidden_fields: ["title"] }, values: {} });
    expect(groups.hidden).toEqual([]);
    expect(groups.shown.map((x) => x.id)).toContain("title");
  });
});

describe("foldLabel", () => {
  it("counts in the singular and the plural, and says what the click does", () => {
    expect(foldLabel("empty", 2, false)).toBe("Show 2 empty properties");
    expect(foldLabel("hidden", 1, false)).toBe("Show 1 hidden property");
    expect(foldLabel("hidden", 3, true)).toBe("Hide 3 hidden properties");
  });
});

describe("recordInitials", () => {
  it("takes the first letter of the first two words, capitalised", () => {
    expect(recordInitials("Harper & Co")).toBe("HC");
    expect(recordInitials("send the quote")).toBe("ST");
    expect(recordInitials("Q3 launch")).toBe("QL");
  });

  it("copes with one word, punctuation, other scripts and nothing", () => {
    expect(recordInitials("Launch")).toBe("L");
    expect(recordInitials("  --  ")).toBe("");
    expect(recordInitials("")).toBe("");
    expect(recordInitials("élodie durand")).toBe("ÉD");
    expect(recordInitials("山田 太郎")).toBe("山太");
  });
});

describe("tileImage", () => {
  const photos = field("attachment", {}, { id: "photos", name: "Photos" });
  const table = makeTable([f("title"), f("x"), photos, field("attachment", {}, { id: "docs", name: "Docs" })]);

  it("is the first image of the collection's first attachment property", () => {
    expect(tileImage(table, { photos: [png, pdf], docs: [{ ...png, id: "other" }] })?.id).toBe("att1");
  });

  it("is none when that file is not an image, or the property is empty, or there is no such property", () => {
    expect(tileImage(table, { photos: [pdf, png] })).toBeNull();
    expect(tileImage(table, {})).toBeNull();
    expect(tileImage(makeTable([f("title")]), {})).toBeNull();
  });

  it("looks at the first attachment property only", () => {
    expect(tileImage(table, { photos: [], docs: [png] })).toBeNull();
  });
});
