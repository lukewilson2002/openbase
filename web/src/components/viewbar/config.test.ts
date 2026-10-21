import { describe, expect, it } from "vitest";
import type { ViewConfig } from "@/api/types";
import { ALL_FIELDS, makeTable } from "@/test/fields";
import { makeView } from "@/test/utils";
import {
  MAX_GROUPS,
  MAX_SORTS,
  addFilterCondition,
  addSortLike,
  moveField,
  moveSortLike,
  queryRelevantKey,
  removeSortLike,
  reorderVisible,
  resolveFieldOrder,
  sanitizeConfig,
  setAllHidden,
  setFieldWidth,
  setFilter,
  setFrozenColumns,
  setHiddenField,
  setRowColor,
  setSummary,
  sortOnly,
  updateSortLike,
} from "./config";

const f = (n: number) => ({ ...ALL_FIELDS.text, id: `f${n}`, name: `F${n}` });
const table = makeTable([f(1), f(2), f(3), f(4)], { primary_field_id: "f1" });
const empty = (): ViewConfig => makeView({ id: "v" }).config;
const ids = (fs: { id: string }[]) => fs.map((x) => x.id);

describe("resolveFieldOrder", () => {
  it("puts the primary first, then field_order, then the rest in table order", () => {
    expect(ids(resolveFieldOrder(table, { ...empty(), field_order: ["f4", "f2"] }).visible)).toEqual(["f1", "f4", "f2", "f3"]);
  });
  it("ignores unknown ids and never hides the primary field", () => {
    const r = resolveFieldOrder(table, { ...empty(), field_order: ["gone", "f1"], hidden_fields: ["f1", "f3"] });
    expect(ids(r.visible)).toEqual(["f1", "f2", "f4"]);
    expect(ids(r.hidden)).toEqual(["f3"]);
    expect(ids(r.all)).toEqual(["f1", "f2", "f3", "f4"]);
  });
});

describe("hiding and ordering", () => {
  it("toggles hidden fields and ignores the primary", () => {
    const c = setHiddenField(empty(), table, "f2", true);
    expect(c.hidden_fields).toEqual(["f2"]);
    expect(setHiddenField(c, table, "f2", true).hidden_fields).toEqual(["f2"]);
    expect(setHiddenField(c, table, "f2", false).hidden_fields).toEqual([]);
    expect(setHiddenField(empty(), table, "f1", true).hidden_fields).toEqual([]);
  });
  it("hides and shows all but the primary", () => {
    expect(setAllHidden(empty(), table, true).hidden_fields).toEqual(["f2", "f3", "f4"]);
    expect(setAllHidden({ ...empty(), hidden_fields: ["f2"] }, table, false).hidden_fields).toEqual([]);
  });
  it("moves fields but never the primary", () => {
    const c = moveField(empty(), table, "f4", "f2");
    expect(c.field_order).toEqual(["f1", "f4", "f2", "f3"]);
    expect(moveField(empty(), table, "f1", "f3")).toEqual(empty());
    expect(moveField(empty(), table, "f2", "f1")).toEqual(empty());
  });
  it("persists a dragged visible order and keeps hidden fields after it", () => {
    const base = { ...empty(), hidden_fields: ["f3"] };
    expect(reorderVisible(base, table, ["f1", "f4", "f2"]).field_order).toEqual(["f1", "f4", "f2", "f3"]);
  });
  it("sets widths (with a floor), frozen columns, row height and summaries", () => {
    expect(setFieldWidth(empty(), "f2", 10.4).field_widths).toEqual({ f2: 40 });
    expect(setFieldWidth(empty(), "f2", 200.6).field_widths).toEqual({ f2: 201 });
    expect(setFrozenColumns(empty(), -2).frozen_columns).toBe(0);
    expect(setSummary(empty(), "f2", "sum").summaries).toEqual({ f2: "sum" });
    expect(setSummary({ ...empty(), summaries: { f2: "sum" } }, "f2", "none").summaries).toEqual({});
  });
});

describe("sorts and groups", () => {
  it("adds without duplicates and respects the limits", () => {
    let c = addSortLike(empty(), "sorts", "f2");
    c = addSortLike(c, "sorts", "f2");
    expect(c.sorts).toEqual([{ field_id: "f2", direction: "asc" }]);
    let g = empty();
    for (let i = 0; i < 6; i++) g = addSortLike(g, "groups", `f${i}`);
    expect(g.groups).toHaveLength(MAX_GROUPS);
    let s = empty();
    for (let i = 0; i < 20; i++) s = addSortLike(s, "sorts", `x${i}`);
    expect(s.sorts).toHaveLength(MAX_SORTS);
  });
  it("updates, removes and reorders", () => {
    let c = addSortLike(addSortLike(addSortLike(empty(), "sorts", "f1"), "sorts", "f2"), "sorts", "f3");
    c = updateSortLike(c, "sorts", 0, { direction: "desc" });
    expect(c.sorts[0]).toEqual({ field_id: "f1", direction: "desc" });
    // Switching to a field already sorted on is refused.
    expect(updateSortLike(c, "sorts", 0, { field_id: "f2" })).toBe(c);
    c = moveSortLike(c, "sorts", 2, 0);
    expect(c.sorts.map((s) => s.field_id)).toEqual(["f3", "f1", "f2"]);
    expect(moveSortLike(c, "sorts", 0, 9)).toBe(c);
    c = removeSortLike(c, "sorts", 1);
    expect(c.sorts.map((s) => s.field_id)).toEqual(["f3", "f2"]);
  });
  it("keeps a group's granularity until its field changes", () => {
    let c = addSortLike(empty(), "groups", "f1");
    c = updateSortLike(c, "groups", 0, { granularity: "month" });
    expect(c.groups[0]).toEqual({ field_id: "f1", direction: "asc", granularity: "month" });
    c = updateSortLike(c, "groups", 0, { direction: "desc" });
    expect(c.groups[0]).toEqual({ field_id: "f1", direction: "desc", granularity: "month" });
    // Another field starts again by day: a granularity only suits a date field.
    c = updateSortLike(c, "groups", 0, { field_id: "f2" });
    expect(c.groups[0]).toEqual({ field_id: "f2", direction: "desc" });
    expect(queryRelevantKey(updateSortLike(c, "groups", 0, { granularity: "year" }))).not.toBe(queryRelevantKey(c));
  });
  it("sortOnly replaces every sort", () => {
    expect(sortOnly(addSortLike(empty(), "sorts", "f1"), "f2", "desc").sorts).toEqual([{ field_id: "f2", direction: "desc" }]);
  });
});

describe("filters and colours", () => {
  it("adds a condition on a field, creating the filter if needed", () => {
    const c = addFilterCondition(empty(), table.fields[1]!);
    expect(c.filter?.items).toEqual([{ field_id: "f2", op: "contains", value: "" }]);
    expect(addFilterCondition(c, table.fields[2]!).filter?.items).toHaveLength(2);
  });
  it("drops an empty filter", () => {
    expect(setFilter(empty(), { conjunction: "and", items: [] }).filter).toBeNull();
    expect(setRowColor(empty(), { mode: "by_select", field_id: "f1" }).row_color).toEqual({ mode: "by_select", field_id: "f1" });
  });
});

describe("sanitizeConfig", () => {
  it("removes references to deleted fields everywhere", () => {
    const c: ViewConfig = {
      ...empty(),
      filter: { conjunction: "and", items: [{ field_id: "f1", op: "is", value: "x" }, { field_id: "gone", op: "is", value: "x" }] },
      sorts: [{ field_id: "gone", direction: "asc" }, { field_id: "f2", direction: "asc" }],
      groups: [{ field_id: "gone", direction: "asc" }],
      hidden_fields: ["gone", "f3"],
      field_order: ["gone", "f2"],
      field_widths: { gone: 100, f2: 120 },
      summaries: { gone: "sum", f2: "sum" },
      row_color: { mode: "by_select", field_id: "gone" },
    };
    const s = sanitizeConfig(c, new Set(["f1", "f2", "f3"]));
    expect(s.filter?.items).toHaveLength(1);
    expect(s.sorts).toEqual([{ field_id: "f2", direction: "asc" }]);
    expect(s.groups).toEqual([]);
    expect(s.hidden_fields).toEqual(["f3"]);
    expect(s.field_order).toEqual(["f2"]);
    expect(s.field_widths).toEqual({ f2: 120 });
    expect(s.summaries).toEqual({ f2: "sum" });
    expect(s.row_color).toBeNull();
  });
  it("prunes rule filters of condition colours and removes an emptied filter", () => {
    const c: ViewConfig = { ...empty(), filter: { conjunction: "and", items: [{ field_id: "gone", op: "is", value: 1 }] }, row_color: { mode: "by_conditions", rules: [{ color: "red", filter: { conjunction: "and", items: [{ field_id: "gone", op: "is", value: 1 }] } }] } };
    const s = sanitizeConfig(c, new Set(["f1"]));
    expect(s.filter).toBeNull();
    expect(s.row_color).toEqual({ mode: "by_conditions", rules: [{ color: "red", filter: { conjunction: "and", items: [] } }] });
  });
  it("is pure", () => {
    const c = empty();
    const copy = structuredClone(c);
    sanitizeConfig(c, new Set());
    setHiddenField(c, table, "f2", true);
    expect(c).toEqual(copy);
  });
});

describe("queryRelevantKey", () => {
  it("changes for query-affecting edits but not for widths or order", () => {
    const k = queryRelevantKey(empty());
    expect(queryRelevantKey(setFieldWidth(empty(), "f2", 300))).toBe(k);
    expect(queryRelevantKey({ ...empty(), field_order: ["f2"] })).toBe(k);
    expect(queryRelevantKey(addSortLike(empty(), "sorts", "f2"))).not.toBe(k);
    expect(queryRelevantKey(setHiddenField(empty(), table, "f2", true))).not.toBe(k);
  });
});
