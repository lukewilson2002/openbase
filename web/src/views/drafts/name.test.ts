import { describe, expect, it } from "vitest";
import type { Filter } from "@/api/types";
import { ALL_FIELDS, field } from "@/test/fields";
import { conditionPhrase, suggestViewName } from "./name";

const status = field("single_select", { choices: [{ id: "s1", name: "Proposal sent", color: "blue" }, { id: "s2", name: "Won", color: "green" }, { id: "s3", name: "Lost", color: "red" }] }, { id: "fStatus", name: "Status" });
const followUp = field("date", { include_time: false, date_format: "iso", time_format: "h24", timezone: null }, { id: "fFollow", name: "Next follow-up" });
const amount = ALL_FIELDS.number!;
const done = field("checkbox", { icon: "check", color: "green" }, { id: "fDone", name: "Done" });
const notes = field("text", { multiline: true }, { id: "fNotes", name: "Notes" });
const fields = [status, followUp, amount, done, notes];

const and = (...items: Filter["items"]): Filter => ({ conjunction: "and", items });
const empty = { filter: null, sorts: [], groups: [] };
const base = { fields, layout: "grid" as const, savedLayout: "grid" as const, viewName: "Clients" };

describe("conditionPhrase", () => {
  it("names a choice by itself", () => {
    expect(conditionPhrase({ field_id: "fStatus", op: "is", value: "s1" }, fields)).toBe("Proposal sent");
    expect(conditionPhrase({ field_id: "fStatus", op: "is_any_of", value: ["s1", "s2"] }, fields)).toBe("Proposal sent or Won");
    expect(conditionPhrase({ field_id: "fStatus", op: "is_not", value: "s3" }, fields)).toBe("not Lost");
  });

  it("reads a date range in words", () => {
    expect(conditionPhrase({ field_id: "fFollow", op: "is_within", value: { mode: "this_calendar_week" } }, fields)).toBe("Next follow-up this calendar week");
    expect(conditionPhrase({ field_id: "fFollow", op: "is_before", value: { mode: "exact_date", date: "2026-11-14" } }, fields)).toBe("Next follow-up is before 2026-11-14");
    expect(conditionPhrase({ field_id: "fFollow", op: "is_within", value: { mode: "past_number_of_days", days: 7 } }, fields)).toBe("Next follow-up the past 7 days");
  });

  it("says emptiness, checkboxes, numbers and text plainly", () => {
    expect(conditionPhrase({ field_id: "fFollow", op: "is_empty", value: null }, fields)).toBe("no Next follow-up");
    expect(conditionPhrase({ field_id: "fFollow", op: "is_not_empty", value: null }, fields)).toBe("has Next follow-up");
    expect(conditionPhrase({ field_id: "fDone", op: "is", value: true }, fields)).toBe("Done");
    expect(conditionPhrase({ field_id: "fDone", op: "is", value: false }, fields)).toBe("not Done");
    expect(conditionPhrase({ field_id: "fNotes", op: "contains", value: "call" }, fields)).toBe("Notes contains call");
    expect(conditionPhrase({ field_id: amount.id, op: "gt", value: 500 }, fields)).toBe(`${amount.name} > 500`);
  });

  it("says nothing for a condition that has no value yet", () => {
    expect(conditionPhrase({ field_id: "fNotes", op: "contains", value: "" }, fields)).toBe("");
    expect(conditionPhrase({ field_id: "fStatus", op: "is_any_of", value: [] }, fields)).toBe("");
    expect(conditionPhrase({ field_id: "fDone", op: "is", value: false }, fields)).toBe("not Done");
    expect(conditionPhrase({ field_id: amount.id, op: "is", value: 0 }, fields)).toBe(`${amount.name} = 0`);
  });

  it("is empty for a property that is gone", () => {
    expect(conditionPhrase({ field_id: "gone", op: "is", value: "x" }, fields)).toBe("");
  });
});

describe("suggestViewName", () => {
  it("is the chips in plain words, joined", () => {
    const filter = and({ field_id: "fStatus", op: "is", value: "s1" }, { field_id: "fFollow", op: "is_within", value: { mode: "this_calendar_week" } });
    expect(suggestViewName({ ...base, config: { ...empty, filter } })).toBe("Proposal sent, Next follow-up this calendar week");
  });

  it("reads conditions inside groups too, and skips the ones it cannot name", () => {
    const filter = and({ field_id: "gone", op: "is", value: "x" }, { conjunction: "or", items: [{ field_id: "fStatus", op: "is", value: "s2" }] });
    expect(suggestViewName({ ...base, config: { ...empty, filter } })).toBe("Won");
  });

  it("falls back to the grouping, then the sort, then the layout, then the view's own name", () => {
    expect(suggestViewName({ ...base, config: { ...empty, groups: [{ field_id: "fStatus", direction: "asc" }], sorts: [{ field_id: "fFollow", direction: "asc" }] } })).toBe("By Status");
    expect(suggestViewName({ ...base, config: { ...empty, sorts: [{ field_id: "fFollow", direction: "asc" }, { field_id: "fStatus", direction: "desc" }] } })).toBe("Sorted by Next follow-up and Status");
    expect(suggestViewName({ ...base, layout: "kanban", config: empty })).toBe("Board");
    expect(suggestViewName({ ...base, config: empty })).toBe("Clients copy");
  });

  it("shortens a very long name", () => {
    const filter = and(...Array.from({ length: 12 }, () => ({ field_id: "fStatus", op: "is" as const, value: "s1" })));
    const name = suggestViewName({ ...base, config: { ...empty, filter } });
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith("…")).toBe(true);
  });
});
