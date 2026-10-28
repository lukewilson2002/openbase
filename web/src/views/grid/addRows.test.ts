import { describe, expect, it } from "vitest";
import type { Filter, GroupHeader } from "@/api/types";
import { ALL_FIELDS, field } from "@/test/fields";
import { floatingAddGroup, groupChain, groupValues, leafGroupOfRow, newRecordValues } from "./addRows";
import { buildRowMap } from "./rowMap";

const status = field("single_select", { choices: [{ id: "s1", name: "Todo", color: "gray" }, { id: "s2", name: "Doing", color: "blue" }] }, { id: "f_status", name: "Status" });
const team = { ...ALL_FIELDS.text, id: "f_team", name: "Team" };
const total = { ...ALL_FIELDS.formula!, id: "f_total", name: "Total" };
const fields = [ALL_FIELDS.text, status, team, total];

const h = (depth: number, field_id: string, key: string, value: unknown, start: number, count: number): GroupHeader => ({ depth, field_id, key, label: key, value: value as GroupHeader["value"], start, count });
const eq = (field_id: string, value: unknown): Filter => ({ conjunction: "and", items: [{ field_id, op: "is", value } as never] });

describe("group values of an add row", () => {
  const groups = [h(0, "f_status", "s1", "s1", 0, 2), h(1, "f_team", "red", "red", 0, 1), h(1, "f_team", "blue", "blue", 1, 1), h(0, "f_status", "s2", "s2", 2, 1), h(1, "f_team", "red", "red", 2, 1)];

  it("walks up to the headers the group sits under", () => {
    expect(groupChain(groups, 2).map((x) => x.key)).toEqual(["s1", "blue"]);
    expect(groupChain(groups, 4).map((x) => x.key)).toEqual(["s2", "red"]);
    expect(groupChain(groups, 0).map((x) => x.key)).toEqual(["s1"]);
    expect(groupChain(groups, 9)).toEqual([]);
  });

  it("has one value per level", () => {
    expect(groupValues(groups, 2, fields)).toEqual({ f_status: "s1", f_team: "blue" });
  });

  it("leaves out computed fields", () => {
    expect(groupValues([h(0, "f_total", "7", 7, 0, 1)], 0, fields)).toEqual({});
  });

  it("merges the group over the filter's values, leaving blank groups out", () => {
    const filter = eq("f_status", "s2");
    expect(newRecordValues(fields, filter, groups, 2)).toEqual({ f_status: "s1", f_team: "blue" });
    expect(newRecordValues(fields, filter, [h(0, "f_status", "", null, 0, 1)], 0)).toEqual({ f_status: "s2" });
    expect(newRecordValues(fields, filter, groups, -1)).toEqual({ f_status: "s2" });
    expect(newRecordValues(fields, null, groups, -1)).toEqual({});
  });

  it("sends links as record ids", () => {
    const link = field("link", { linked_table_id: "tbl2", inverse_field_id: "f_back", single: false }, { id: "f_link", name: "Link" });
    expect(newRecordValues([link], null, [h(0, "f_link", "rec1", [{ id: "rec1", name: "One" }], 0, 1)], 0)).toEqual({ f_link: ["rec1"] });
  });
});

describe("which group the floating Add adds into", () => {
  const groups = [h(0, "f_status", "A", "s1", 0, 2), h(0, "f_status", "B", "s2", 2, 2)];
  // Rows: 0 header A, 1-2 records, 3 add, 4 header B, 5-6 records, 7 add, 8 summary.
  const map = buildRowMap(4, groups, new Set(), true);

  it("maps rows to leaf groups", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((r) => leafGroupOfRow(map, groups, r))).toEqual([0, 0, 0, 0, 1, 1, 1, 1, -1]);
  });

  it("takes the group of the selected row", () => {
    expect(floatingAddGroup(map, groups, 5, 0)).toBe(1);
    expect(floatingAddGroup(map, groups, 1, 4)).toBe(0);
  });

  it("falls back to the group at the top of the screen with nothing selected", () => {
    expect(floatingAddGroup(map, groups, null, 5)).toBe(1);
    expect(floatingAddGroup(map, groups, null, 0)).toBe(0);
  });

  it("looks at the top row when the selection is not on a group", () => {
    expect(floatingAddGroup(map, groups, 8, 6)).toBe(1);
  });

  it("is the end of the table without groups or with none in view", () => {
    expect(floatingAddGroup(buildRowMap(4, [], new Set(), true), [], 2, 0)).toBe(-1);
    expect(floatingAddGroup(map, groups, null, null)).toBe(-1);
  });

  it("names the first leaf under a header of nested groups", () => {
    const nested = [h(0, "f_status", "A", "s1", 0, 2), h(1, "f_team", "x", "x", 0, 1), h(1, "f_team", "y", "y", 1, 1)];
    const m = buildRowMap(2, nested, new Set(), true);
    expect(leafGroupOfRow(m, nested, 0)).toBe(1);
    expect(floatingAddGroup(m, nested, null, 0)).toBe(1);
    expect(floatingAddGroup(m, nested, 4, null)).toBe(2);
  });
});
