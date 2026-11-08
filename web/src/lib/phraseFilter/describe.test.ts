import { describe, expect, it } from "vitest";
import type { Condition, DateOperand, Field } from "@/api/types";
import { field } from "@/test/fields";
import { conditionLabel, describeCondition } from "./describe";
import { parsePhrase, labelText, type FilterCandidate } from "./index";

const DATE = { include_time: false, date_format: "us", time_format: "h12", timezone: null } as const;
const named = (id: string, name: string) => ({ id, name });

const FIELDS: Field[] = [
  field("text", { multiline: false }, named("f_name", "Name")),
  field("number", { precision: 0, allow_negative: true }, named("f_amount", "Amount")),
  field("currency", { precision: 2, symbol: "$", allow_negative: true }, named("f_price", "Price")),
  field("percent", { precision: 1, allow_negative: true }, named("f_margin", "Margin")),
  field("checkbox", { icon: "check", color: "green" }, named("f_done", "Done")),
  field("single_select", { choices: [{ id: "c1", name: "Lead", color: "gray" }, { id: "c2", name: "Won", color: "green" }] }, named("f_status", "Status")),
  field("multiple_select", { choices: [{ id: "t1", name: "Urgent", color: "red" }, { id: "t2", name: "Bug", color: "gray" }] }, named("f_tags", "Tags")),
  field("user", { multiple: false, notify: false }, named("f_owner", "Owner")),
  field("link", { linked_table_id: "tbl2", inverse_field_id: "f_inv", single: false }, named("f_contact", "Contact")),
  field("date", DATE, named("f_followup", "Next follow-up")),
];

const NOW = Date.UTC(2026, 10, 7, 15, 0);
const PEOPLE = [{ id: "u_dana", name: "Dana Reyes" }];
const say = (c: Condition) => conditionLabel(c, FIELDS, { collaborators: PEOPLE, timeZone: "UTC", now: NOW });
const when = (operand: DateOperand): Condition => ({ field_id: "f_followup", op: "is_within", value: operand as unknown as Condition["value"] });

describe("conditionLabel", () => {
  it.each<[string, Condition, string]>([
    ["text contains", { field_id: "f_name", op: "contains", value: "dana" }, "Name contains dana"],
    ["text is not", { field_id: "f_name", op: "is_not", value: "x" }, "Name is not x"],
    ["emptiness needs no value", { field_id: "f_name", op: "is_empty", value: null }, "Name is empty"],
    ["not empty", { field_id: "f_contact", op: "is_not_empty", value: null }, "Contact is not empty"],
    ["a number over", { field_id: "f_amount", op: "gt", value: 500 }, "Amount is over 500"],
    ["a number at most", { field_id: "f_amount", op: "lte", value: 1200 }, "Amount is at most 1,200"],
    ["currency", { field_id: "f_price", op: "gte", value: 99.5 }, "Price is at least $99.5"],
    ["percent", { field_id: "f_margin", op: "lt", value: 12 }, "Margin is under 12%"],
    ["a checkbox", { field_id: "f_done", op: "is", value: true }, "Done is checked"],
    ["an unchecked checkbox", { field_id: "f_done", op: "is", value: false }, "Done is unchecked"],
    ["a choice by its name", { field_id: "f_status", op: "is", value: "c2" }, "Status is Won"],
    ["several choices", { field_id: "f_status", op: "is_any_of", value: ["c1", "c2"] }, "Status is any of Lead, Won"],
    ["multi select", { field_id: "f_tags", op: "has_all_of", value: ["t1", "t2"] }, "Tags has all of Urgent, Bug"],
    ["me", { field_id: "f_owner", op: "is", value: "me" }, "Owner is me"],
    ["a person by name", { field_id: "f_owner", op: "is", value: "u_dana" }, "Owner is Dana Reyes"],
    ["a person who left", { field_id: "f_owner", op: "is", value: "u_gone" }, "Owner is someone"],
    ["linked records", { field_id: "f_contact", op: "has_any_of", value: ["r1", "r2"] }, "Contact has any of 2 linked records"],
    ["one linked record", { field_id: "f_contact", op: "has_any_of", value: ["r1"] }, "Contact has any of 1 linked record"],
    ["a date", { field_id: "f_followup", op: "is", value: { mode: "today" } as never }, "Next follow-up is today"],
    ["before a day this year", { field_id: "f_followup", op: "is_before", value: { mode: "exact_date", date: "2026-11-14" } as never }, "Next follow-up is before Nov 14"],
    ["before a day in another year", { field_id: "f_followup", op: "is_before", value: { mode: "exact_date", date: "2025-03-02" } as never }, "Next follow-up is before Mar 2, 2025"],
    ["a day still being picked", { field_id: "f_followup", op: "is", value: { mode: "exact_date", date: "" } as never }, "Next follow-up is …"],
    ["a text with nothing typed yet", { field_id: "f_name", op: "contains", value: "" }, "Name contains …"],
    ["a choice that was deleted", { field_id: "f_status", op: "is", value: "c_gone" }, "Status is …"],
    ["a property that was deleted", { field_id: "f_gone", op: "contains", value: "x" }, "Deleted property contains"],
  ])("%s", (_name, cond, expected) => {
    expect(say(cond)).toBe(expected);
  });

  it.each<[DateOperand, string]>([
    [{ mode: "this_calendar_week" }, "this week"],
    [{ mode: "next_calendar_week" }, "next week"],
    [{ mode: "last_calendar_week" }, "last week"],
    [{ mode: "this_calendar_month" }, "this month"],
    [{ mode: "next_calendar_month" }, "next month"],
    [{ mode: "last_calendar_month" }, "last month"],
    [{ mode: "this_calendar_year" }, "this year"],
    [{ mode: "past_week" }, "past week"],
    [{ mode: "past_year" }, "past year"],
    [{ mode: "next_week" }, "the next week"],
    [{ mode: "past_number_of_days", days: 7 }, "past 7 days"],
    [{ mode: "next_number_of_days", days: 1 }, "next 1 day"],
    [{ mode: "number_of_days_ago", days: 3 }, "3 days ago"],
    [{ mode: "number_of_days_from_now", days: 2 }, "in 2 days"],
    [{ mode: "one_week_ago" }, "a week ago"],
    [{ mode: "one_month_from_now" }, "in a month"],
  ])("a date range %j reads %s", (operand, words) => {
    expect(say(when(operand))).toBe(`Next follow-up is ${words}`);
  });

  it("gives the property and the value as the parts a suggestion draws in bold", () => {
    expect(describeCondition({ field_id: "f_status", op: "is", value: "c2" }, FIELDS)).toEqual([
      { role: "property", text: "Status" },
      { role: "operator", text: "is" },
      { role: "value", text: "Won" },
    ]);
  });

  it("reads a suggestion's condition as the suggestion did, so applying it does not change the words", () => {
    const ctx = { fields: FIELDS, userId: "u_luke", collaborators: PEOPLE, now: NOW, timeZone: "UTC", weekStart: 0 as const };
    for (const text of ["status is won", "next follow-up this week", "amount over 500", "owner is dana", "done checked", "next follow-up before nov 14", "contact is empty"]) {
      const top = parsePhrase(text, ctx).find((c): c is FilterCandidate => c.kind === "filter");
      expect(top, text).toBeDefined();
      expect(conditionLabel(top!.condition, FIELDS, { collaborators: PEOPLE, timeZone: "UTC", now: NOW }), text).toBe(labelText(top!.label));
    }
  });
});
