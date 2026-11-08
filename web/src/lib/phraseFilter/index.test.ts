import { describe, expect, it } from "vitest";
import type { Condition, Field } from "@/api/types";
import { field } from "@/test/fields";
import { labelText, parsePhrase, type Candidate, type FilterCandidate, type PhraseContext } from "./index";
import { segment, type ChoiceEntry } from "./values";
import { fold, tokenize, valueText } from "./tokens";

// Saturday, November 7, 2026, 15:00 UTC: the same moment the date-phrase tests read from.
const NOW = Date.UTC(2026, 10, 7, 15, 0);

const choices = (...names: string[]) => names.map((name) => ({ id: `c_${name.toLowerCase().replace(/\W+/g, "_")}`, name, color: "gray" }));
const DATE = { include_time: false, date_format: "us", time_format: "h12", timezone: null } as const;
const named = (id: string, name: string) => ({ id, name });

const FIELDS: Field[] = [
  field("text", { multiline: false }, named("f_name", "Name")),
  field("text", { multiline: false }, named("f_company", "Company")),
  field("email", {}, named("f_email", "Email")),
  field("rich_text", {}, named("f_notes", "Notes")),
  field("text", { multiline: true }, named("f_description", "Description")),
  field("number", { precision: 0, allow_negative: true }, named("f_amount", "Amount")),
  field("currency", { precision: 2, symbol: "$", allow_negative: true }, named("f_price", "Price")),
  field("percent", { precision: 1, allow_negative: true }, named("f_margin", "Margin")),
  field("duration", { format: "h_mm" }, named("f_time", "Time spent")),
  field("rating", { max: 5, icon: "star", color: "yellow" }, named("f_rating", "Rating")),
  field("checkbox", { icon: "check", color: "green" }, named("f_done", "Done")),
  field("checkbox", { icon: "check", color: "green" }, named("f_archived", "Archived")),
  field("single_select", { choices: choices("Lead", "Proposal sent", "Won", "Lost", "On hold") }, named("f_status", "Status")),
  field("single_select", { choices: choices("High", "Medium", "Low") }, named("f_priority", "Priority")),
  field("single_select", { choices: choices("Enterprise", "SMB", "Sales or marketing") }, named("f_segment", "Segment")),
  field("multiple_select", { choices: choices("Urgent", "Bug", "Design", "Won") }, named("f_tags", "Tags")),
  field("user", { multiple: false, notify: false }, named("f_owner", "Owner")),
  field("user", { multiple: true, notify: false }, named("f_reviewers", "Reviewers")),
  field("link", { linked_table_id: "tbl2", inverse_field_id: "f_inv", single: false }, named("f_contact", "Contact")),
  field("attachment", {}, named("f_files", "Attachments")),
  field("date", DATE, named("f_followup", "Next follow-up")),
  field("date", { ...DATE, include_time: true }, named("f_due", "Due")),
  field("created_time", { ...DATE, include_time: true }, named("f_created", "Created")),
  field("created_by", {}, named("f_created_by", "Created by")),
  field("formula", { expression: "{Amount}*2", result_type: "number", format: { kind: "number", precision: 0 } }, named("f_score", "Score")),
  field("button", { label: "Open", url_formula: "{url}" }, named("f_open", "Open")),
];

const PEOPLE = [
  { id: "u_luke", name: "Luke Wilson" },
  { id: "u_dana", name: "Dana Reyes" },
  { id: "u_sam", name: "Sam Ortiz" },
];

const CTX: PhraseContext = { fields: FIELDS, userId: "u_luke", collaborators: PEOPLE, now: NOW, timeZone: "UTC", weekStart: 0 };

// ---- helpers: a candidate written as "Property op value" so cases read like the spec ----

const NAMES = new Map<string, string>([
  ...FIELDS.flatMap((f) => (f.type === "single_select" || f.type === "multiple_select" ? f.options.choices.map((c) => [c.id, c.name] as const) : [])),
  ...PEOPLE.map((p) => [p.id, p.name] as const),
]);

function show(value: Condition["value"]): string {
  if (value === null) return "";
  if (Array.isArray(value)) return `[${value.map((v) => NAMES.get(String(v)) ?? String(v)).join(", ")}]`;
  if (typeof value === "object") {
    const v = value as { mode: string; days?: number; date?: string };
    return v.date ? `${v.mode}:${v.date}` : v.days !== undefined ? `${v.mode}:${v.days}` : v.mode;
  }
  return NAMES.get(String(value)) ?? String(value);
}

function sig(c: FilterCandidate, fields: readonly Field[] = FIELDS): string {
  const f = fields.find((x) => x.id === c.condition.field_id)!;
  return [f.name, c.condition.op, show(c.condition.value)].filter((p) => p !== "").join(" ");
}

const filters = (text: string, ctx: PhraseContext = CTX): FilterCandidate[] => parsePhrase(text, ctx).filter((c): c is FilterCandidate => c.kind === "filter");
const sigs = (text: string, ctx: PhraseContext = CTX): string[] => filters(text, ctx).map((c) => sig(c, ctx.fields));
const top = (text: string, ctx: PhraseContext = CTX): string | null => sigs(text, ctx)[0] ?? null;

const wk = (mode: string) => `Next follow-up is_within ${mode}`;

// ---- the table: at least 150 phrase-to-filter cases ----

const CASES: readonly (readonly [phrase: string, expected: string | null])[] = [
  // text: is, is not, contains, doesn't contain, starts with, ends with
  ["name contains dana", "Name contains dana"],
  ["Name contains Dana", "Name contains Dana"],
  ["NAME CONTAINS DANA", "Name contains DANA"],
  ["name contain dana", "Name contains dana"],
  ["name includes dana", "Name contains dana"],
  ["name has dana", "Name contains dana"],
  ["name doesn't contain dana", "Name does_not_contain dana"],
  ["name does not contain dana", "Name does_not_contain dana"],
  ["name doesnt contain dana", "Name does_not_contain dana"],
  ["name without dana", "Name does_not_contain dana"],
  ["name starts with da", "Name starts_with da"],
  ["name begins with da", "Name starts_with da"],
  ["name ends with son", "Name ends_with son"],
  ["name ending with son", "Name ends_with son"],
  ["name is Dana", "Name is Dana"],
  ["name = Dana", "Name is Dana"],
  ["name: Dana", "Name is Dana"],
  ["name:Dana", "Name is Dana"],
  ["name equals Dana", "Name is Dana"],
  ["name is not Dana", "Name is_not Dana"],
  ["name isn't Dana", "Name is_not Dana"],
  ["name != Dana", "Name is_not Dana"],
  ["name ≠ Dana", "Name is_not Dana"],
  ["name <> Dana", "Name is_not Dana"],
  ["company contains acme corp", "Company contains acme corp"],
  ['company contains "acme corp"', "Company contains acme corp"],
  ["company contains “acme corp”", "Company contains acme corp"],
  ["email contains @example.com", "Email contains @example.com"],
  ["email ends with .org", "Email ends_with .org"],
  ["name contains dana.", "Name contains dana"],
  ["name contains Mary-Ann", "Name contains Mary-Ann"],
  ["notes contain budget", "Notes contains budget"],
  // text needs an operator and a value
  ["name contains", null],
  ["name dana", null],
  ["name is", null],
  ["name is not", null],
  ["name", null],
  ["contains dana", null],
  // empty and not empty
  ["name is empty", "Name is_empty"],
  ["name empty", "Name is_empty"],
  ["name blank", "Name is_empty"],
  ["name is blank", "Name is_empty"],
  ["name is not set", "Name is_empty"],
  ["name is not empty", "Name is_not_empty"],
  ["name not empty", "Name is_not_empty"],
  ["name isn't empty", "Name is_not_empty"],
  ["name filled", "Name is_not_empty"],
  ["name is set", "Name is_not_empty"],
  ["no name", "Name is_empty"],
  ["without company", "Company is_empty"],
  ["missing email", "Email is_empty"],
  ["with company", "Company is_not_empty"],
  ["has email", "Email is_not_empty"],
  ["empty notes", "Notes is_empty"],
  ["no contact", "Contact is_empty"],
  ["with contact", "Contact is_not_empty"],
  ["contact is empty", "Contact is_empty"],
  ["no attachments", "Attachments is_empty"],
  ["with attachments", "Attachments is_not_empty"],
  ["no status", "Status is_empty"],
  ["status is not empty", "Status is_not_empty"],
  ["no owner", "Owner is_empty"],
  ["tags is empty", "Tags is_empty"],
  ["no next follow-up", "Next follow-up is_empty"],
  ["with follow-up", "Next follow-up is_not_empty"],
  ["amount is empty", "Amount is_empty"],
  ["rating is not empty", "Rating is_not_empty"],
  ["no done", null],
  ["done is empty", null],
  // links and attachments
  ["contact contains dana", "Contact contains dana"],
  ["contact doesn't contain dana", "Contact does_not_contain dana"],
  ["contact is dana", null],
  ["attachments contain invoice", "Attachments contains invoice"],
  ["attachments contain invoice.pdf", "Attachments contains invoice.pdf"],
  // numbers: words and symbols
  ["amount > 500", "Amount gt 500"],
  ["amount>500", "Amount gt 500"],
  ["amount >= 500", "Amount gte 500"],
  ["amount ≥ 500", "Amount gte 500"],
  ["amount < 500", "Amount lt 500"],
  ["amount <= 500", "Amount lte 500"],
  ["amount ≤ 500", "Amount lte 500"],
  ["amount = 500", "Amount is 500"],
  ["amount is 500", "Amount is 500"],
  ["amount 500", "Amount is 500"],
  ["amount != 500", "Amount is_not 500"],
  ["amount is not 500", "Amount is_not 500"],
  ["amount over 500", "Amount gt 500"],
  ["amount is over 500", "Amount gt 500"],
  ["amount more than 500", "Amount gt 500"],
  ["amount above 500", "Amount gt 500"],
  ["amount greater than 500", "Amount gt 500"],
  ["amount at least 500", "Amount gte 500"],
  ["amount minimum 500", "Amount gte 500"],
  ["amount no less than 500", "Amount gte 500"],
  ["amount under 500", "Amount lt 500"],
  ["amount less than 500", "Amount lt 500"],
  ["amount below 500", "Amount lt 500"],
  ["amount fewer than 500", "Amount lt 500"],
  ["amount at most 500", "Amount lte 500"],
  ["amount up to 500", "Amount lte 500"],
  ["amount max 500", "Amount lte 500"],
  ["amount no more than 500", "Amount lte 500"],
  ["amount over 1,500", "Amount gt 1500"],
  ["amount over 1500.5", "Amount gt 1500.5"],
  ["amount under -5", "Amount lt -5"],
  ["amount over 2k", "Amount gt 2000"],
  ["amount over 1.5k", "Amount gt 1500"],
  ["amount over", null],
  ["amount over abc", null],
  ["amount over 5 apples", null],
  ["amount over 20%", null],
  ["amount 5 6", null],
  ["amount over 1,5", null],
  ["amount over 1,500,000", "Amount gt 1500000"],
  ["amount over 11/14", null],
  ["amount over 2026-11-14", null],
  ["500 amount", null],
  ["score over 10", "Score gt 10"],
  // currency, percent, duration, rating
  ["price over $500", "Price gt 500"],
  ["price over 500", "Price gt 500"],
  ["price under $1,200.50", "Price lt 1200.5"],
  ["price at least $5k", "Price gte 5000"],
  ["price over 500 dollars", null],
  ["margin over 20%", "Margin gt 20"],
  ["margin over 20", "Margin gt 20"],
  ["margin at least 12.5%", "Margin gte 12.5"],
  ["time spent over 2 hours", "Time spent gt 7200"],
  ["time spent under 90 minutes", "Time spent lt 5400"],
  ["time spent at least 1:30", "Time spent gte 5400"],
  ["time spent over 1h 30m", "Time spent gt 5400"],
  ["time spent over 90", null],
  ["rating at least 4", "Rating gte 4"],
  ["rating over 3 stars", "Rating gt 3"],
  ["rating = 5", "Rating is 5"],
  ["rating is 5", "Rating is 5"],
  ["rating 3", "Rating is 3"],
  ["rating under 2", "Rating lt 2"],
  ["rating at most 4", "Rating lte 4"],
  ["rating at least ★★★", "Rating gte 3"],
  ["rating over 6", null],
  ["rating over 2.5", null],
  // checkboxes
  ["done is checked", "Done is true"],
  ["done checked", "Done is true"],
  ["done is true", "Done is true"],
  ["done yes", "Done is true"],
  ["done = true", "Done is true"],
  ["done unchecked", "Done is false"],
  ["done is unchecked", "Done is false"],
  ["done not checked", "Done is false"],
  ["done is not checked", "Done is false"],
  ["done no", "Done is false"],
  ["checked done", "Done is true"],
  ["unchecked done", "Done is false"],
  ["not done", "Done is false"],
  ["archived is checked", "Archived is true"],
  ["done maybe", null],
  ["done", null],
  // choices
  ["status is lead", "Status is Lead"],
  ["status lead", "Status is Lead"],
  ["status = won", "Status is Won"],
  ["status: won", "Status is Won"],
  ["status:lead", "Status is Lead"],
  ["status is proposal sent", "Status is Proposal sent"],
  ["status Proposal Sent", "Status is Proposal sent"],
  ["status is not lead", "Status is_not Lead"],
  ["status isn't lost", "Status is_not Lost"],
  ["status != lost", "Status is_not Lost"],
  ["status is lead or won", "Status is_any_of [Lead, Won]"],
  ["status lead or won", "Status is_any_of [Lead, Won]"],
  ["status is lead, won", "Status is_any_of [Lead, Won]"],
  ["status is any of lead or won", "Status is_any_of [Lead, Won]"],
  ["status is one of lead, proposal sent", "Status is_any_of [Lead, Proposal sent]"],
  ["status is not lead or won", "Status is_none_of [Lead, Won]"],
  ["status none of lead or won", "Status is_none_of [Lead, Won]"],
  ["status contains lead", "Status is Lead"],
  ["status doesn't contain lead", "Status is_not Lead"],
  ["status is on hold", "Status is On hold"],
  ["status is unknown", null],
  ["status lead and won", null],
  ["status is", null],
  ["status", null],
  ["priority high", "Priority is High"],
  ["priority is medium", "Priority is Medium"],
  ["priority low or medium", "Priority is_any_of [Low, Medium]"],
  ["segment sales or marketing", "Segment is Sales or marketing"],
  ["segment enterprise or smb", "Segment is_any_of [Enterprise, SMB]"],
  ["segment is sales or marketing or smb", "Segment is_any_of [Sales or marketing, SMB]"],
  ["status is 'lead'", "Status is Lead"],
  ['status is "proposal sent"', "Status is Proposal sent"],
  // multiple choices
  ["tags urgent", "Tags has_any_of [Urgent]"],
  ["tags has urgent", "Tags has_any_of [Urgent]"],
  ["tags contains urgent", "Tags has_any_of [Urgent]"],
  ["tags is urgent or bug", "Tags has_any_of [Urgent, Bug]"],
  ["tags include urgent or bug", "Tags has_any_of [Urgent, Bug]"],
  ["tags urgent and bug", "Tags has_all_of [Urgent, Bug]"],
  ["tags has all of urgent, bug", "Tags has_all_of [Urgent, Bug]"],
  ["tags is exactly urgent", "Tags is_exactly [Urgent]"],
  ["tags exactly urgent and bug", "Tags is_exactly [Urgent, Bug]"],
  ["tags is not urgent", "Tags has_none_of [Urgent]"],
  ["tags without urgent", "Tags has_none_of [Urgent]"],
  ["tags doesn't contain bug", "Tags has_none_of [Bug]"],
  ["tags none of urgent or bug", "Tags has_none_of [Urgent, Bug]"],
  ["tags is not urgent and bug", null],
  // bare choice values: exactly one property has the choice
  ["proposal sent", "Status is Proposal sent"],
  ["lead", "Status is Lead"],
  ["on hold", "Status is On hold"],
  ["high", "Priority is High"],
  ["lead or won", "Status is_any_of [Lead, Won]"],
  ["urgent", "Tags has_any_of [Urgent]"],
  ["urgent and bug", "Tags has_all_of [Urgent, Bug]"],
  ["urgent or bug", "Tags has_any_of [Urgent, Bug]"],
  ["design", "Tags has_any_of [Design]"],
  ["won", null],
  ["bogus", null],
  // people
  ["owner is me", "Owner is me"],
  ["owner me", "Owner is me"],
  ["owner mine", "Owner is me"],
  ["owner is not me", "Owner is_not me"],
  ["owner is dana", "Owner is Dana Reyes"],
  ["owner dana reyes", "Owner is Dana Reyes"],
  ["owner is me or dana", "Owner is_any_of [me, Dana Reyes]"],
  ["owner is sam", "Owner is Sam Ortiz"],
  ["reviewers me", "Reviewers has_any_of [me]"],
  ["reviewers include dana and sam", "Reviewers has_all_of [Dana Reyes, Sam Ortiz]"],
  ["created by me", "Created by is me"],
  ["owner is nobody", null],
  // bare "me", "mine", "checked"
  ["mine", "Owner is me"],
  ["me", "Owner is me"],
  ["checked", "Done is true"],
  ["unchecked", "Done is false"],
  ["not checked", "Done is false"],
  ["assigned to me", null],
  // dates
  ["next follow-up is this week", wk("this_calendar_week")],
  ["follow-up this week", wk("this_calendar_week")],
  ["follow-up next week", wk("next_calendar_week")],
  ["follow-up last week", wk("last_calendar_week")],
  ["follow-up this month", wk("this_calendar_month")],
  ["follow-up next month", wk("next_calendar_month")],
  ["follow-up last month", wk("last_calendar_month")],
  ["follow-up this year", wk("this_calendar_year")],
  ["follow-up past 7 days", wk("past_number_of_days:7")],
  ["follow-up next 30 days", wk("next_number_of_days:30")],
  ["follow-up last 14 days", wk("past_number_of_days:14")],
  ["follow-up past 2 weeks", wk("past_number_of_days:14")],
  ["follow-up past week", wk("past_week")],
  ["follow-up past month", wk("past_month")],
  ["follow-up past year", wk("past_year")],
  ["follow-up is within the next 30 days", wk("next_number_of_days:30")],
  ["follow-up in the past 7 days", wk("past_number_of_days:7")],
  ["follow-up next year", null],
  ["follow-up last year", null],
  ["follow-up today", "Next follow-up is today"],
  ["follow-up is today", "Next follow-up is today"],
  ["follow-up tomorrow", "Next follow-up is tomorrow"],
  ["follow-up yesterday", "Next follow-up is yesterday"],
  ["follow-up on Nov 14", "Next follow-up is exact_date:2026-11-14"],
  ["follow-up Nov 14", "Next follow-up is exact_date:2026-11-14"],
  ["follow-up is 11/14", "Next follow-up is exact_date:2026-11-14"],
  ["follow-up 2026-11-14", "Next follow-up is exact_date:2026-11-14"],
  ["follow-up on November 14th", "Next follow-up is exact_date:2026-11-14"],
  ["follow-up on Friday", "Next follow-up is exact_date:2026-11-13"],
  ["follow-up before Nov 14", "Next follow-up is_before exact_date:2026-11-14"],
  ["follow-up is before Nov 14", "Next follow-up is_before exact_date:2026-11-14"],
  ["follow-up after Nov 14", "Next follow-up is_after exact_date:2026-11-14"],
  ["follow-up on or before Nov 14", "Next follow-up is_on_or_before exact_date:2026-11-14"],
  ["follow-up on or after 2026-12-01", "Next follow-up is_on_or_after exact_date:2026-12-01"],
  ["follow-up by Friday", "Next follow-up is_on_or_before exact_date:2026-11-13"],
  ["follow-up since Nov 1", "Next follow-up is_on_or_after exact_date:2026-11-01"],
  ["follow-up until Nov 20", "Next follow-up is_on_or_before exact_date:2026-11-20"],
  ["follow-up < Nov 14", "Next follow-up is_before exact_date:2026-11-14"],
  ["follow-up > Nov 14", "Next follow-up is_after exact_date:2026-11-14"],
  ["follow-up <= Nov 14", "Next follow-up is_on_or_before exact_date:2026-11-14"],
  ["follow-up >= Nov 14", "Next follow-up is_on_or_after exact_date:2026-11-14"],
  ["follow-up is not Nov 14", "Next follow-up is_not exact_date:2026-11-14"],
  ["follow-up before today", "Next follow-up is_before today"],
  ["follow-up after yesterday", "Next follow-up is_after yesterday"],
  ["follow-up in 3 days", "Next follow-up is number_of_days_from_now:3"],
  ["follow-up 3 days ago", "Next follow-up is number_of_days_ago:3"],
  ["follow-up in a week", "Next follow-up is one_week_from_now"],
  ["follow-up a week ago", "Next follow-up is one_week_ago"],
  ["follow-up a month ago", "Next follow-up is one_month_ago"],
  ["follow-up before this week", null],
  ["follow-up is not this week", null],
  ["follow-up 9am", null],
  ["follow-up at noon", null],
  ["follow-up soon", null],
  ["follow-up", null],
  ["due this week", "Due is_within this_calendar_week"],
  ["due tomorrow", "Due is tomorrow"],
  ["created today", "Created is today"],
  // bare dates: only when exactly one date property exists (here two, so none)
  ["this week", null],
  ["tomorrow", null],
  // punctuation, case and spacing
  ["Next Follow-Up Is This Week", wk("this_calendar_week")],
  ["next follow up is this week", wk("this_calendar_week")],
  ["next follow-up: this week", wk("this_calendar_week")],
  ["  status   is   lead  ", "Status is Lead"],
  ["status is lead!", "Status is Lead"],
  ["status is lead.", "Status is Lead"],
  ["(status is lead)", "Status is Lead"],
  ["STATUS=LEAD", "Status is Lead"],
  ["status\tis\tlead", "Status is Lead"],
  // unreadable text and empty input
  ["", null],
  ["   ", null],
  ["xyzzy", null],
  ["budget review", null],
  ["foo bar baz", null],
  ["!!!", null],
  ["???", null],
  ["...", null],
  ["= = =", null],
  ["is", null],
  ["and", null],
  ["open is empty", null],
];

describe("the phrase table", () => {
  it("has at least 150 cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(150);
  });

  it.each(CASES.map((c) => [JSON.stringify(c[0]), c] as const))("%s", (_label, [phrase, expected]) => {
    expect(top(phrase)).toBe(expected);
  });
});

// ---- ranking ----

describe("ranking", () => {
  const dateFields: Field[] = [
    field("date", DATE, named("d_date", "Date")),
    field("date", DATE, named("d_birth", "Date of birth")),
    field("date", DATE, named("d_born", "Birth date")),
    field("date", DATE, named("d_next", "Next date")),
  ];
  const dates: PhraseContext = { ...CTX, fields: dateFields };

  it("puts an exact name before a prefix and a prefix before a partial match", () => {
    expect(sigs("date is today", dates)).toEqual(["Date is today", "Date of birth is today", "Birth date is today", "Next date is today"]);
  });

  it("breaks ties between equal matches by the order of the properties", () => {
    const reversed: PhraseContext = { ...dates, fields: [...dateFields].reverse() };
    expect(sigs("date is today", reversed)).toEqual(["Date is today", "Date of birth is today", "Next date is today", "Birth date is today"]);
  });

  it("reads a longer name as the better match", () => {
    expect(sigs("date of birth is today", dates)).toEqual(["Date of birth is today"]);
  });

  it("is not misled by a name inside the value", () => {
    expect(sigs("notes contain status", CTX)).toEqual(["Notes contains status"]);
  });

  it("prefers a property named in the text over a bare choice", () => {
    expect(sigs("status won", CTX)).toEqual(["Status is Won"]);
  });

  it("orders people by where they sit, with who made a record last", () => {
    expect(sigs("mine", CTX)).toEqual(["Owner is me", "Reviewers has_any_of [me]", "Created by is me"]);
  });

  it("lists every checkbox for a bare checked", () => {
    expect(sigs("checked", CTX)).toEqual(["Done is true", "Archived is true"]);
  });

  it("gives every candidate a score and returns them best first", () => {
    const out = parsePhrase("follow-up this week", CTX);
    const scores = out.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("does not repeat a filter", () => {
    const keys = filters("status is lead or lead", CTX).map((c) => JSON.stringify(c.condition));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is the same every time", () => {
    expect(parsePhrase("follow-up this week", CTX)).toEqual(parsePhrase("follow-up this week", CTX));
  });
});

// ---- the three kinds ----

describe("filters, long text and search", () => {
  it("offers the filter, then Notes and Description as long text, then search", () => {
    const out = parsePhrase("follow-up this week", CTX);
    expect(out.map((c) => c.kind)).toEqual(["filter", "long-text", "long-text", "search"]);
    expect(labelText(out[0]!.label)).toBe("Next follow-up is this week");
    expect(labelText(out[1]!.label)).toBe("Notes contain “follow-up this week”");
    expect(labelText(out[3]!.label)).toBe("Search every property for “follow-up this week”");
  });

  it("builds the long-text condition from the whole text", () => {
    const long = parsePhrase("follow-up this week", CTX).find((c): c is FilterCandidate => c.kind === "long-text")!;
    expect(long.condition).toEqual({ field_id: "f_notes", op: "contains", value: "follow-up this week" });
    expect(long.fieldId).toBe("f_notes");
  });

  it("skips the long-text candidate for a property the text already names", () => {
    const out = parsePhrase("notes contain budget", CTX);
    expect(out.filter((c) => c.kind === "long-text").map((c) => (c as FilterCandidate).fieldId)).toEqual(["f_description"]);
  });

  it("gives text it cannot read the search suggestion alone", () => {
    const out = parsePhrase("budget review", CTX);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "search", query: "budget review" });
  });

  it("gives a pasted passage the search suggestion alone", () => {
    const long = `status is lead ${"word ".repeat(80)}`;
    expect(parsePhrase(long, CTX).map((c) => c.kind)).toEqual(["search"]);
  });

  it("gives empty text nothing", () => {
    expect(parsePhrase("", CTX)).toEqual([]);
    expect(parsePhrase("  \n ", CTX)).toEqual([]);
  });

  it("offers no long-text candidate when there is no long-text property", () => {
    const small: PhraseContext = { ...CTX, fields: FIELDS.filter((f) => f.id !== "f_notes" && f.id !== "f_description") };
    expect(parsePhrase("status lead", small).map((c) => c.kind)).toEqual(["filter", "search"]);
  });

  it("collapses the whitespace in the search query", () => {
    const out = parsePhrase("  hello    world  ", CTX);
    expect(out.at(-1)).toMatchObject({ kind: "search", query: "hello world" });
  });

  it("does not offer buttons or fields it cannot filter on", () => {
    const out = parsePhrase("open contains x", CTX);
    expect(out.map((c) => c.kind)).toEqual(["search"]);
  });
});

// ---- labels ----

describe("labels", () => {
  const labelOf = (text: string): string => labelText(filters(text)[0]!.label);

  it("splits a label into property, operator and value", () => {
    expect(filters("status is lead", CTX)[0]!.label).toEqual([
      { role: "property", text: "Status" },
      { role: "operator", text: "is" },
      { role: "value", text: "Lead" },
    ]);
  });

  it("has no value part when the operator needs none", () => {
    expect(filters("no contact", CTX)[0]!.label.map((p) => p.role)).toEqual(["property", "operator"]);
    expect(labelOf("no contact")).toBe("Contact is empty");
  });

  it.each([
    ["amount over 500", "Amount is over 500"],
    ["amount at least 1,500", "Amount is at least 1,500"],
    ["amount at most 2k", "Amount is at most 2,000"],
    ["price under $12.5", "Price is under $12.5"],
    ["margin over 20", "Margin is over 20%"],
    ["time spent over 2 hours", "Time spent is over 2 hours"],
    ["rating at least 1", "Rating is at least 1 star"],
    ["rating at least ★★★", "Rating is at least 3 stars"],
    ["done unchecked", "Done is unchecked"],
    ["name doesn't contain x", "Name doesn't contain x"],
    ["status not lead or won", "Status is none of Lead, Won"],
    ["status lead or won", "Status is any of Lead, Won"],
    ["tags urgent and bug", "Tags has all of Urgent, Bug"],
    ["owner is me", "Owner is me"],
    ["follow-up next week", "Next follow-up is next week"],
    ["follow-up past 7 days", "Next follow-up is past 7 days"],
    ["follow-up past 1 days", "Next follow-up is past 1 day"],
    ["follow-up before Nov 14", "Next follow-up is before Nov 14"],
    ["follow-up on 2027-01-05", "Next follow-up is Jan 5, 2027"],
    ["follow-up 3 days ago", "Next follow-up is 3 days ago"],
    ["follow-up in 3 days", "Next follow-up is in 3 days"],
    ["follow-up on or after Friday", "Next follow-up is on or after Nov 13"],
  ])("%s reads %s", (text, expected) => {
    expect(labelOf(text)).toBe(expected);
  });
});

// ---- the context ----

describe("context", () => {
  it("does not read me or mine without a signed-in person", () => {
    const anon: PhraseContext = { ...CTX, userId: null };
    expect(sigs("owner is me", anon)).toEqual([]);
    expect(sigs("mine", anon)).toEqual([]);
    expect(sigs("owner is dana", anon)).toEqual(["Owner is Dana Reyes"]);
  });

  it("writes the me marker the server resolves for each viewer", () => {
    expect(filters("owner is me", CTX)[0]!.condition).toEqual({ field_id: "f_owner", op: "is", value: "me" });
    expect(filters("reviewers mine", CTX)[0]!.condition).toEqual({ field_id: "f_reviewers", op: "has_any_of", value: ["me"] });
  });

  it("does not guess between two people with the same first name", () => {
    const twins: PhraseContext = { ...CTX, collaborators: [...PEOPLE, { id: "u_dana2", name: "Dana Kim" }] };
    expect(sigs("owner is dana", twins)).toEqual([]);
    expect(top("owner is dana kim", twins)).toBe("Owner is u_dana2");
  });

  it("reads days against the clock it is given", () => {
    const later: PhraseContext = { ...CTX, now: Date.UTC(2027, 0, 2, 12, 0) };
    expect(top("follow-up on Friday", later)).toBe("Next follow-up is exact_date:2027-01-08");
    expect(top("follow-up on Nov 14", later)).toBe("Next follow-up is exact_date:2027-11-14");
    expect(labelText(filters("follow-up on Nov 14", later)[0]!.label)).toBe("Next follow-up is Nov 14");
  });

  it("reads a day with no year as this year's, behind us or ahead", () => {
    expect(top("follow-up on Jan 5", CTX)).toBe("Next follow-up is exact_date:2026-01-05");
    expect(top("follow-up after 3/4", CTX)).toBe("Next follow-up is_after exact_date:2026-03-04");
    expect(top("follow-up on Jan 5 2028", CTX)).toBe("Next follow-up is exact_date:2028-01-05");
  });

  it("reads this year in the zone it is given", () => {
    const tokyo: PhraseContext = { ...CTX, timeZone: "Asia/Tokyo", now: Date.UTC(2026, 11, 31, 20, 0) };
    expect(top("follow-up on Jan 5", tokyo)).toBe("Next follow-up is exact_date:2027-01-05");
  });

  it("reads next Friday from the week start it is given", () => {
    const sunday: PhraseContext = { ...CTX, now: Date.UTC(2026, 10, 8, 12, 0), weekStart: 0 };
    const monday: PhraseContext = { ...sunday, weekStart: 1 };
    expect(top("follow-up on next Friday", sunday)).toBe("Next follow-up is exact_date:2026-11-20");
    expect(top("follow-up on next Friday", monday)).toBe("Next follow-up is exact_date:2026-11-13");
  });

  it("reads a bare date phrase when exactly one date property exists", () => {
    const one: PhraseContext = { ...CTX, fields: FIELDS.filter((f) => f.id !== "f_due") };
    expect(top("this week", one)).toBe(wk("this_calendar_week"));
    expect(top("before Nov 14", one)).toBe("Next follow-up is_before exact_date:2026-11-14");
    expect(top("2026-11-14", one)).toBe("Next follow-up is exact_date:2026-11-14");
    expect(top("soon", one)).toBeNull();
  });

  it("never offers a property that is not in the context", () => {
    const some: PhraseContext = { ...CTX, fields: FIELDS.filter((f) => f.id === "f_name") };
    expect(sigs("status is lead", some)).toEqual([]);
    expect(sigs("name contains x", some)).toEqual(["Name contains x"]);
  });

  it("gives a collection with no properties only the search suggestion", () => {
    expect(parsePhrase("status is lead", { ...CTX, fields: [] }).map((c) => c.kind)).toEqual(["search"]);
  });

  it("reads accents and case in property names", () => {
    const accents: PhraseContext = { ...CTX, fields: [field("text", { multiline: false }, named("f_cafe", "Café"))] };
    expect(top("CAFE contains x", accents)).toBe("Café contains x");
    expect(top("café contains x", accents)).toBe("Café contains x");
  });

  it("reads names with punctuation in them", () => {
    const odd: PhraseContext = { ...CTX, fields: [field("text", { multiline: false }, named("f_sm", "Sales & marketing")), field("text", { multiline: false }, named("f_client", "Client's name"))] };
    expect(top("sales & marketing contains x", odd)).toBe("Sales & marketing contains x");
    expect(top("sales marketing contains x", odd)).toBe("Sales & marketing contains x");
    expect(top("clients name contains x", odd)).toBe("Client's name contains x");
    expect(top("client's name contains x", odd)).toBe("Client's name contains x");
  });

  it("matches whole words only", () => {
    expect(sigs("nam contains x", CTX)).toEqual([]);
    expect(sigs("names contains x", CTX)).toEqual([]);
  });
});

// ---- the pieces ----

describe("segment", () => {
  const entries = (...names: string[]): ChoiceEntry[] => names.map((n) => ({ id: n, label: n, words: n.toLowerCase().split(" ") }));

  it("reads one name, or names joined by or", () => {
    expect(segment(["lead"], entries("Lead"), false)?.entries.map((e) => e.id)).toEqual(["Lead"]);
    expect(segment(["lead", "or", "won"], entries("Lead", "Won"), false)?.joiner).toBe("or");
  });

  it("reads a name that holds or as one name first", () => {
    expect(segment(["sales", "or", "marketing"], entries("Sales or marketing", "Sales", "Marketing"), false)?.entries).toHaveLength(1);
  });

  it("refuses and unless allowed, and refuses a mix", () => {
    expect(segment(["a", "and", "b"], entries("A", "B"), false)).toBeNull();
    expect(segment(["a", "and", "b"], entries("A", "B"), true)?.joiner).toBe("and");
    expect(segment(["a", "and", "b", "or", "c"], entries("A", "B", "C"), true)).toBeNull();
  });

  it("refuses words left over", () => {
    expect(segment(["lead", "please"], entries("Lead"), false)).toBeNull();
    expect(segment([], entries("Lead"), false)).toBeNull();
  });
});

describe("tokens", () => {
  it("folds case, accents and apostrophes", () => {
    expect(fold("Café's")).toBe("cafes");
  });

  it("keeps the value as typed", () => {
    const typed = "name contains  Follow-up, Q4.";
    expect(valueText(typed, tokenize(typed).slice(2))).toBe("Follow-up, Q4");
  });

  it("splits symbols from words", () => {
    expect(tokenize("a>=5").map((t) => t.key)).toEqual(["a", ">=", "5"]);
    expect(tokenize("a≥5").map((t) => t.key)).toEqual(["a", ">=", "5"]);
    expect(tokenize("a<>b").map((t) => t.key)).toEqual(["a", "!=", "b"]);
  });
});

// ---- nothing it returns may be a candidate it should not have made ----

describe("candidates are well formed", () => {
  const all = CASES.map((c) => c[0]);
  const fieldsById = new Map(FIELDS.map((f) => [f.id, f] as const));

  it.each(all.filter((p) => p.trim() !== "").map((p) => [JSON.stringify(p), p] as const))("%s", (_label, phrase) => {
    const out: Candidate[] = parsePhrase(phrase, CTX);
    expect(out.at(-1)?.kind).toBe("search");
    for (const c of out) {
      if (c.kind === "search") continue;
      const f = fieldsById.get(c.condition.field_id);
      expect(f).toBeDefined();
      expect(c.label[0]).toMatchObject({ role: "property", text: f!.name });
    }
  });
});
