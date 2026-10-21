import { describe, expect, it } from "vitest";
import { ALL_FIELDS, field } from "@/test/fields";
import { autoAssign, checkAssignment, cleanHeaderName, columnNames, importProblem, mappingKeys, mappingPayload, tableNameFromFile } from "./mapping";
import { decodeCsv, detectDelimiter, dropBlankRows, encodingProblem, parseCsvText } from "./parse";

const bytes = (...b: number[]) => Uint8Array.from(b);
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("reading the top of a CSV", () => {
  it("parses quoted fields with delimiters, doubled quotes and line breaks", () => {
    const p = parseCsvText('Name,Notes\r\n"Smith, Ann","said ""hi"""\r\n"Two\nlines",x\r\n', 10);
    expect(p.delimiter).toBe(",");
    expect(p.rows).toEqual([
      ["Name", "Notes"],
      ["Smith, Ann", 'said "hi"'],
      ["Two\nlines", "x"],
    ]);
    expect(p.more).toBe(false);
  });

  it("skips empty lines and handles a missing final newline and ragged rows", () => {
    const p = parseCsvText("a,b,c\n\n1,2\n\n3,4,5,6", 10);
    expect(p.rows).toEqual([["a", "b", "c"], ["1", "2"], ["3", "4", "5", "6"]]);
  });

  it("keeps a line of only delimiters (an empty record) out of the way of blank-line skipping", () => {
    expect(parseCsvText("a,b\n,\n", 10).rows).toEqual([["a", "b"], ["", ""]]);
    expect(dropBlankRows([["a"], ["", " "], ["b"]])).toEqual([["a"], ["b"]]);
  });

  it("stops after the requested rows and says there is more", () => {
    const p = parseCsvText("h\n1\n2\n3\n4\n", 3);
    expect(p.rows).toEqual([["h"], ["1"], ["2"]]);
    expect(p.more).toBe(true);
    expect(parseCsvText("h\n1\n", 5).more).toBe(false);
  });

  it("detects semicolons and tabs outside quotes, like the server", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter('"a;b",c,d\n')).toBe(",");
    expect(detectDelimiter("single")).toBe(",");
    expect(parseCsvText("a;b\n1;2\n", 5).rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("drops a byte order mark, reads Latin-1 when it is not UTF-8, and refuses UTF-16", () => {
    expect(decodeCsv(bytes(0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62))).toBe("a,b");
    expect(decodeCsv(utf8("café"))).toBe("café");
    expect(decodeCsv(bytes(0x63, 0x61, 0x66, 0xe9))).toBe("café"); // Latin-1 "é"
    // The start of a bigger file may end inside a character.
    expect(decodeCsv(bytes(0x61, 0xc3), true)).toBe("a");
    expect(encodingProblem(bytes(0xff, 0xfe, 0x61, 0x00))).toMatch(/UTF-16/);
    expect(encodingProblem(utf8("a,b"))).toBeNull();
  });
});

describe("column names as the server derives them", () => {
  it("trims, drops control characters and fills in empty names", () => {
    expect(cleanHeaderName("  Name \u0007", 0)).toBe("Name");
    expect(cleanHeaderName("   ", 2)).toBe("Column 3");
    expect(cleanHeaderName("x".repeat(300), 0)).toHaveLength(255);
  });

  it("makes repeated names unique, ignoring case", () => {
    expect(columnNames(["Name", "name", "Name", "", ""], 5, true)).toEqual(["Name", "name 2", "Name 3", "Column 4", "Column 5"]);
  });

  it("names every column 'Column N' without a header, and keys the mapping by position", () => {
    const names = columnNames(["a", "b"], 3, false);
    expect(names).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(mappingKeys(names, false)).toEqual(["0", "1", "2"]);
    expect(mappingKeys(["a", "b"], true)).toEqual(["a", "b"]);
  });

  it("pads a short header to the widest row", () => {
    expect(columnNames(["a"], 3, true)).toEqual(["a", "Column 2", "Column 3"]);
  });
});

describe("matching columns to fields", () => {
  const name = field("text", { multiline: false }, { id: "f_name", name: "Name" });
  const qty = field("number", { precision: 0, allow_negative: true }, { id: "f_qty", name: "Qty" });
  const owner = field("user", { multiple: false, notify: false }, { id: "f_owner", name: "Owner" });
  const total = field("formula", { expression: "1", result_type: "number" }, { id: "f_total", name: "Total" });
  const fields = [name, qty, owner, total];

  it("matches by name, ignoring case, using each field once", () => {
    expect(autoAssign(["NAME", "qty", "Name", "Other"], fields)).toEqual(["f_name", "f_qty", null, null]);
  });

  it("never offers fields the server cannot import into", () => {
    expect(autoAssign(["Owner", "Total"], fields)).toEqual([null, null]);
    expect(importProblem(owner)).toMatch(/user/);
    expect(importProblem(total)).toBe("computed");
    expect(importProblem(ALL_FIELDS.link!)).toMatch(/link/);
    expect(importProblem(ALL_FIELDS.attachment!)).toMatch(/attachments/);
    expect(importProblem(name)).toBeNull();
  });

  it("needs at least one column and no field twice", () => {
    expect(checkAssignment([null, null])).toEqual({ mapped: 0, duplicates: [], ok: false });
    expect(checkAssignment(["f_name", null, "f_qty"])).toEqual({ mapped: 2, duplicates: [], ok: true });
    expect(checkAssignment(["f_name", "f_name"])).toMatchObject({ duplicates: ["f_name"], ok: false });
  });

  it("builds the payload with null for skipped columns", () => {
    expect(mappingPayload(["Name", "Notes", "Qty"], ["f_name", null, "f_qty"])).toEqual({ Name: "f_name", Notes: null, Qty: "f_qty" });
  });
});

describe("a name for a new table", () => {
  it("comes from the file name", () => {
    expect(tableNameFromFile("People 2026.csv")).toBe("People 2026");
    expect(tableNameFromFile("export.CSV")).toBe("export");
    expect(tableNameFromFile(".csv")).toBe("Imported table");
  });
});
