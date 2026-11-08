import { describe, expect, it } from "vitest";
import type { Filter, ViewConfig } from "@/api/types";
import { makeView } from "@/test/utils";
import { applyDraft, applyTransient, changedOnServer, diffChanges, fingerprint, nextDraft, parseDraft, sameSetting, toTransient, touches, type ViewDraft } from "./draft";

const filter: Filter = { conjunction: "and", items: [{ field_id: "fld1", op: "contains", value: "x" }] };
const cfg = (over: Partial<ViewConfig> = {}): ViewConfig => ({ ...makeView({ id: "viw1" }).config, ...over });
const asc = (field_id: string) => ({ field_id, direction: "asc" as const });

describe("diffChanges and applyDraft", () => {
  it("holds only the draft settings that differ, each with its whole value", () => {
    const saved = cfg();
    const next = cfg({ filter, sorts: [asc("fld1")], field_widths: { fld1: 300 }, kanban: { ...saved.kanban, hide_empty_stacks: true } });
    expect(diffChanges(saved, next)).toEqual({ filter, sorts: [asc("fld1")], field_widths: { fld1: 300 }, kanban: { ...saved.kanban, hide_empty_stacks: true } });
    expect(applyDraft(saved, { changes: diffChanges(saved, next) })).toEqual(next);
  });

  it("is empty when nothing differs, however the settings were built", () => {
    const saved = cfg({ field_widths: { a: 1, b: 2 }, filter });
    expect(diffChanges(saved, cfg({ field_widths: { b: 2, a: 1 }, filter: { ...filter } }))).toEqual({});
    expect(applyDraft(saved, null)).toBe(saved);
  });

  it("never holds the form: its changes are not drafts", () => {
    const saved = cfg();
    expect(diffChanges(saved, cfg({ form: { ...saved.form, title: "Hello" } }))).toEqual({});
  });

  it("treats no filter, an empty filter and no row colors as one thing", () => {
    expect(sameSetting("filter", cfg(), cfg({ filter: { conjunction: "or", items: [] } }))).toBe(true);
    expect(sameSetting("filter", cfg({ filter: null }), cfg({ filter: undefined }))).toBe(true);
    expect(sameSetting("row_color", cfg(), cfg({ row_color: { mode: "by_conditions", rules: [] } }))).toBe(true);
    expect(sameSetting("row_color", cfg(), cfg({ row_color: { mode: "by_select", field_id: "fld1" } }))).toBe(false);
  });

  it("records a filter cleared by hand as null", () => {
    expect(diffChanges(cfg({ filter }), cfg())).toEqual({ filter: null });
    expect(applyDraft(cfg({ filter }), { changes: { filter: null } }).filter).toBeNull();
  });
});

describe("toTransient and applyTransient", () => {
  it("is null while the draft leaves the query alone", () => {
    const saved = cfg({ filter, sorts: [asc("fld1")] });
    expect(toTransient(saved, saved)).toBeNull();
    expect(toTransient(saved, { ...saved, field_widths: { fld1: 99 }, hidden_fields: ["fld2"] })).toBeNull();
    expect(applyTransient(saved, null)).toBe(saved);
  });

  it("sends the query settings that differ, and only those", () => {
    const saved = cfg();
    expect(toTransient(saved, cfg({ filter }))).toEqual({ filter });
    expect(toTransient(saved, cfg({ sorts: [asc("fld1")], groups: [asc("fld2")] }))).toEqual({ sorts: [asc("fld1")], groups: [asc("fld2")] });
  });

  it("sends row colors and summaries, so the server computes them (BE-12)", () => {
    const saved = cfg();
    const rowColor = { mode: "by_select", field_id: "fld1" } as const;
    expect(toTransient(saved, cfg({ row_color: rowColor, summaries: { fld1: "sum" } }))).toEqual({ row_color: rowColor, summaries: { fld1: "sum" } });
  });

  it("drops what the view saved with the words the server understands", () => {
    const saved = cfg({ filter, sorts: [asc("fld1")], row_color: { mode: "by_select", field_id: "fld1" }, summaries: { fld1: "sum" } });
    const t = toTransient(saved, cfg());
    // No filter is a filter without items; no row colors is by_conditions with no rules; no summaries is {}.
    expect(t).toEqual({ filter: { conjunction: "and", items: [] }, sorts: [], row_color: { mode: "by_conditions", rules: [] }, summaries: {} });
    const effective = applyTransient(saved, t);
    expect(effective.filter).toBeNull();
    expect(effective.sorts).toEqual([]);
    expect(effective.row_color).toBeNull();
    expect(effective.summaries).toEqual({});
  });

  it("keeps the saved value of every part the override leaves out", () => {
    const saved = cfg({ filter, groups: [asc("fld1")], summaries: { fld1: "sum" } });
    const effective = applyTransient(saved, { sorts: [asc("fld2")] });
    expect(effective.filter).toEqual(filter);
    expect(effective.groups).toEqual(saved.groups);
    expect(effective.summaries).toEqual({ fld1: "sum" });
    expect(effective.sorts).toEqual([asc("fld2")]);
  });
});

describe("nextDraft", () => {
  const saved = { type: "grid" as const, config: cfg() };

  it("starts a draft with the fingerprint of the saved config and keeps its start", () => {
    const first = nextDraft(null, saved, cfg({ filter }), "grid", 1000)!;
    expect(first).toEqual({ v: 1, base: fingerprint(saved.config), started: 1000, changes: { filter } });
    const second = nextDraft(first, saved, cfg({ filter, sorts: [asc("fld1")] }), "grid", 5000)!;
    expect(second.started).toBe(1000);
    expect(second.base).toBe(first.base);
    expect(second.changes).toEqual({ filter, sorts: [asc("fld1")] });
  });

  it("is gone once the changes are undone by hand", () => {
    const first = nextDraft(null, saved, cfg({ filter }), "grid", 1)!;
    expect(nextDraft(first, saved, cfg(), "grid", 2)).toBeNull();
  });

  it("holds a layout of its own, until it is the view's again", () => {
    const first = nextDraft(null, saved, cfg(), "kanban", 1)!;
    expect(first.layout).toBe("kanban");
    expect(first.changes).toEqual({});
    expect(nextDraft(first, saved, cfg(), "grid", 2)).toBeNull();
  });

  it("takes the fingerprint of the saved config when it came from the old storage without one", () => {
    const moved: ViewDraft = { v: 1, base: null, started: 3, changes: { sorts: [asc("fld1")], row_height: "short" } };
    const adopted = nextDraft(moved, saved, applyDraft(saved.config, moved), "grid", 9)!;
    expect(adopted.base).toBe(fingerprint(saved.config));
    // What equals the saved view is dropped.
    expect(adopted.changes).toEqual({ sorts: [asc("fld1")] });
  });
});

describe("changedOnServer", () => {
  it("is true once the saved config is not the one the draft started from", () => {
    const saved = cfg();
    const draft = nextDraft(null, { type: "grid", config: saved }, cfg({ filter }), "grid", 1)!;
    expect(changedOnServer(draft, saved)).toBe(false);
    expect(changedOnServer(draft, { ...saved, row_height: "tall" })).toBe(true);
    // Equal content is not a change, however the object was made.
    expect(changedOnServer(draft, JSON.parse(JSON.stringify(saved)) as ViewConfig)).toBe(false);
  });

  it("says nothing without a draft, or for a draft that has not met its view yet", () => {
    expect(changedOnServer(null, cfg())).toBe(false);
    expect(changedOnServer({ v: 1, base: null, started: 0, changes: { filter } }, cfg())).toBe(false);
  });
});

describe("fingerprint", () => {
  it("ignores the order of keys and tells configs apart", () => {
    expect(fingerprint(cfg({ field_widths: { a: 1, b: 2 } }))).toBe(fingerprint(cfg({ field_widths: { b: 2, a: 1 } })));
    expect(fingerprint(cfg())).not.toBe(fingerprint(cfg({ row_height: "tall" })));
    expect(fingerprint(cfg())).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("touches", () => {
  it("asks whether a draft changes any of some settings", () => {
    const d = { changes: { sorts: [asc("fld1")] } };
    expect(touches(d, ["filter", "sorts"])).toBe(true);
    expect(touches(d, ["filter"])).toBe(false);
    expect(touches(null, ["sorts"])).toBe(false);
  });
});

describe("parseDraft", () => {
  it("round-trips a draft with a layout", () => {
    const d = nextDraft(null, { type: "grid", config: cfg() }, cfg({ sorts: [asc("fld1")] }), "kanban", 5)!;
    expect(parseDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it("refuses what is not a draft and drops settings that make no sense", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("x")).toBeNull();
    expect(parseDraft({ v: 2, changes: { sorts: [] } })).toBeNull();
    expect(parseDraft({ v: 1, changes: {} })).toBeNull();
    const parsed = parseDraft({ v: 1, base: 7, changes: { sorts: "nope", row_height: "huge", frozen_columns: -1, form: { title: "x" }, wrap_headers: true, bogus: 1 }, layout: "spreadsheet" });
    expect(parsed).toEqual({ v: 1, base: null, started: 0, changes: { wrap_headers: true } });
  });
});
