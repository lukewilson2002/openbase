import { describe, expect, it } from "vitest";
import type { View } from "@/api/types";
import { ROLES } from "@/lib/roles";
import { canConfigureView, draftActions, draftLayout } from "./permissions";
import type { ViewDraft } from "./draft";

type Kind = Pick<View, "personal" | "locked" | "is_default" | "type">;
const shared: Kind = { personal: false, locked: false, is_default: false, type: "grid" };
const locked: Kind = { ...shared, locked: true };
const personal: Kind = { ...shared, personal: true };
const defaultGrid: Kind = { ...shared, is_default: true };

const draft = (over: Partial<ViewDraft> = {}): ViewDraft => ({ v: 1, base: "x", started: 1, changes: { sorts: [{ field_id: "fld1", direction: "asc" }] }, ...over });
const layoutOnly = draft({ changes: { field_widths: { fld1: 300 } } });

describe("canConfigureView", () => {
  it("follows the server: editors on shared views, creators on locked ones, the owner's editor role on personal ones", () => {
    const table: [string, Pick<View, "personal" | "locked">, boolean[]][] = [
      // viewer, commenter, editor, creator, owner
      ["shared", shared, [false, false, true, true, true]],
      ["locked", locked, [false, false, false, true, true]],
      ["personal", personal, [false, false, true, true, true]],
    ];
    for (const [, view, expected] of table) expect(ROLES.map((r) => canConfigureView(r, view))).toEqual(expected);
  });
});

describe("what the changes bar offers, by role", () => {
  // [viewer, commenter, editor, creator, owner]
  const row = (view: Kind, d: ViewDraft | null, pick: "canUpdate" | "canSaveAsView" | "canSaveForEveryone") => ROLES.map((r) => draftActions(r, view, d)[pick]);

  it("Reset is for everyone, so viewers and commenters have no other button", () => {
    for (const view of [shared, locked, personal, defaultGrid]) {
      expect(row(view, draft(), "canUpdate").slice(0, 2)).toEqual([false, false]);
      expect(row(view, draft(), "canSaveAsView").slice(0, 2)).toEqual([false, false]);
    }
  });

  it("Update view is for people who may configure the view", () => {
    expect(row(shared, draft(), "canUpdate")).toEqual([false, false, true, true, true]);
    expect(row(locked, draft(), "canUpdate")).toEqual([false, false, false, true, true]);
    expect(row(personal, draft(), "canUpdate")).toEqual([false, false, true, true, true]);
  });

  it("Save as view is for editors and up, and Everyone needs the creator role", () => {
    for (const view of [shared, locked, personal, defaultGrid]) {
      expect(row(view, draft(), "canSaveAsView")).toEqual([false, false, true, true, true]);
    }
    expect(row(shared, draft(), "canSaveForEveryone")).toEqual([false, false, false, true, true]);
  });

  it("offers nothing without a draft", () => {
    for (const r of ROLES) expect(draftActions(r, shared, null)).toMatchObject({ canUpdate: false, canSaveAsView: false });
  });

  it("does not update a view into another layout: that is always a new view", () => {
    const board = draft({ layout: "kanban" });
    expect(row(shared, board, "canUpdate")).toEqual([false, false, false, false, false]);
    expect(row(shared, board, "canSaveAsView")).toEqual([false, false, true, true, true]);
    // Switching back to the view's own layout is no switch.
    expect(draftActions("editor", shared, draft({ layout: "grid" })).canUpdate).toBe(true);
  });

  it("on the default view, editors and up update the layout settings only", () => {
    expect(row(defaultGrid, layoutOnly, "canUpdate")).toEqual([false, false, true, true, true]);
    expect(draftActions("editor", defaultGrid, layoutOnly).updateKeys).toEqual(["hidden_fields", "field_order", "field_widths", "frozen_columns", "row_height", "wrap_headers"]);
    // A filter, sort, group or color can only become a new view.
    for (const changes of [{ filter: { conjunction: "and" as const, items: [] } }, { sorts: [] }, { groups: [] }, { row_color: null }, { summaries: {} }, { description_field_id: null }]) {
      expect(row(defaultGrid, draft({ changes }), "canUpdate")).toEqual([false, false, false, false, false]);
    }
    // Mixed: Update view is there, for the layout part.
    expect(draftActions("editor", defaultGrid, draft({ changes: { field_widths: { fld1: 300 }, sorts: [] } })).canUpdate).toBe(true);
  });

  it("on any other view, Update view takes every draft setting", () => {
    expect(draftActions("editor", shared, draft()).updateKeys).toContain("sorts");
    expect(draftActions("editor", shared, draft()).updateKeys).not.toContain("form");
  });
});

describe("draftLayout", () => {
  it("is the view's own layout unless the draft switched it", () => {
    expect(draftLayout(shared, null)).toBe("grid");
    expect(draftLayout(shared, draft())).toBe("grid");
    expect(draftLayout(shared, draft({ layout: "calendar" }))).toBe("calendar");
  });
});
