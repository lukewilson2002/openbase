import { describe, expect, it } from "vitest";
import type { ViewConfig } from "@/api/types";
import { makeView } from "@/test/utils";
import { DRAFT_KEYS, IMMEDIATE_KEYS, LAYOUT_KEYS, QUERY_KEYS, SETTING_CLASS } from "./classify";

describe("what goes into a draft", () => {
  it("classifies every key of a view config, and nothing else", () => {
    const keys = Object.keys(makeView({ id: "viw1" }).config).sort();
    // `filter`, `row_color` and `description_field_id` are optional, so a config may leave them out.
    const optional = ["filter", "row_color", "description_field_id"];
    expect(Object.keys(SETTING_CLASS).sort()).toEqual([...new Set([...keys, ...optional])].sort());
  });

  it("matches the spec's table, row by row", () => {
    const group = (k: keyof ViewConfig) => SETTING_CLASS[k].group;
    // Filter, sorts, groups, row colors and summaries are drafts the server computes.
    expect(QUERY_KEYS).toEqual(["filter", "sorts", "groups", "row_color", "summaries"]);
    // The layout settings, the only ones Update view saves on the default view.
    expect(LAYOUT_KEYS).toEqual(["hidden_fields", "field_order", "field_widths", "frozen_columns", "row_height", "wrap_headers"]);
    expect(group("description_field_id")).toBe("cards");
    for (const k of ["kanban", "calendar", "gallery", "list", "timeline"] as const) expect(group(k)).toBe("layout-settings");
  });

  it("makes the form's own settings the one thing that saves at once", () => {
    expect(IMMEDIATE_KEYS).toEqual(["form"]);
    expect(DRAFT_KEYS).not.toContain("form");
    expect(DRAFT_KEYS.length + IMMEDIATE_KEYS.length).toBe(Object.keys(SETTING_CLASS).length);
  });
});
