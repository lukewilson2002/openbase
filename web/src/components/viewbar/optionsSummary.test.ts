import { describe, expect, it } from "vitest";
import { ALL_FIELDS, makeTable } from "@/test/fields";
import { colorSummary, groupSummary, propertiesSummary, sortSummary } from "./optionsSummary";

const name = { ...ALL_FIELDS.text, id: "fld_name", name: "Name" };
const due = { ...ALL_FIELDS.date, id: "fld_due", name: "Next follow-up" };
const qty = { ...ALL_FIELDS.number, id: "fld_qty", name: "Qty" };
const done = { ...ALL_FIELDS.checkbox, id: "fld_done", name: "Done" };
const status = { ...ALL_FIELDS.single_select, id: "fld_status", name: "Status" };
const fields = [name, due, qty, done, status];

describe("sortSummary", () => {
  it("says None for no sorts", () => {
    expect(sortSummary(fields, [])).toBe("None");
  });

  it("names the first sort and its order in words that fit the property", () => {
    expect(sortSummary(fields, [{ field_id: due.id, direction: "asc" }])).toBe("Next follow-up, soonest");
    expect(sortSummary(fields, [{ field_id: due.id, direction: "desc" }])).toBe("Next follow-up, latest");
    expect(sortSummary(fields, [{ field_id: qty.id, direction: "asc" }])).toBe("Qty, lowest first");
    expect(sortSummary(fields, [{ field_id: qty.id, direction: "desc" }])).toBe("Qty, highest first");
    expect(sortSummary(fields, [{ field_id: done.id, direction: "asc" }])).toBe("Done, unchecked first");
    expect(sortSummary(fields, [{ field_id: name.id, direction: "desc" }])).toBe("Name, Z to A");
  });

  it("counts the others", () => {
    expect(
      sortSummary(fields, [
        { field_id: name.id, direction: "asc" },
        { field_id: qty.id, direction: "asc" },
        { field_id: due.id, direction: "asc" },
      ]),
    ).toBe("Name, A to Z, and 2 more");
  });

  it("does not break on a property that was deleted", () => {
    expect(sortSummary(fields, [{ field_id: "gone", direction: "asc" }])).toBe("Deleted property, A to Z");
  });
});

describe("groupSummary", () => {
  it("says None, or By and the property", () => {
    expect(groupSummary(fields, [])).toBe("None");
    expect(groupSummary(fields, [{ field_id: status.id, direction: "asc" }])).toBe("By Status");
  });

  it("adds how much time a date group spans, and counts the other levels", () => {
    expect(groupSummary(fields, [{ field_id: due.id, direction: "asc", granularity: "month" }])).toBe("By Next follow-up, month");
    expect(
      groupSummary(fields, [
        { field_id: status.id, direction: "asc" },
        { field_id: due.id, direction: "asc" },
      ]),
    ).toBe("By Status, and 1 more");
  });

  it("leaves a granularity out for a property that is not a date", () => {
    expect(groupSummary(fields, [{ field_id: status.id, direction: "asc", granularity: "month" }])).toBe("By Status");
  });
});

describe("colorSummary", () => {
  it("says None, By a property, or By conditions", () => {
    expect(colorSummary(fields, null)).toBe("None");
    expect(colorSummary(fields, undefined)).toBe("None");
    expect(colorSummary(fields, { mode: "by_select", field_id: status.id })).toBe("By Status");
    expect(colorSummary(fields, { mode: "by_conditions", rules: [{ color: "red", filter: { conjunction: "and", items: [] } }] })).toBe("By conditions");
  });

  it("says None for conditions with no rules", () => {
    expect(colorSummary(fields, { mode: "by_conditions", rules: [] })).toBe("None");
  });
});

describe("propertiesSummary", () => {
  const table = makeTable(fields);
  it("counts what is shown and what is hidden", () => {
    expect(propertiesSummary(table, { field_order: [], hidden_fields: [] })).toBe("5 shown");
    expect(propertiesSummary(table, { field_order: [], hidden_fields: [due.id] })).toBe("4 shown, 1 hidden");
  });

  it("never hides the title property", () => {
    expect(propertiesSummary(table, { field_order: [], hidden_fields: [name.id, qty.id] })).toBe("4 shown, 1 hidden");
  });
});
