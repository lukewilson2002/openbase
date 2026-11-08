/**
 * Calendar-week and calendar-month dates in filters (BE-7): the week starts on the request's
 * `week_start`, else the caller's profile (`api.auth.updateMe`), else Sunday. Run through the real
 * client against the real server, on a view query, on the summary bar and on a saved view.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { http } from "../src/api/client";
import { api } from "../src/api/endpoints";
import { recordsApi, schemaApi } from "../src/api/records";
import type { DateOperand, Filter, Table, View } from "../src/api/types";
import { createWorld, expectError, failure, joinBase, newUser, type Profile, type World } from "./support";
import { parse } from "./typecheck";

const DAY = 86_400_000;

/** Whole days since the epoch of a `YYYY-MM-DD` date, so weeks are plain arithmetic. */
const toDay = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const fromDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const todayUtc = () => toDay(new Date().toISOString().slice(0, 10));
/** 0 = Sunday. 1970-01-01 was a Thursday. */
const weekday = (day: number) => (((day + 4) % 7) + 7) % 7;
/** The first day of the week that holds `day`, for weeks that start on `weekStart`. */
const weekFirst = (day: number, weekStart: 0 | 1) => day - ((weekday(day) - weekStart + 7) % 7);

// Five people dated around the Sunday-start week that holds today, so Sunday and Monday weeks hold
// different people on any day of the week: the Saturday before it, its Sunday, its Monday, its
// Saturday, and the Sunday after.
const PEOPLE = [
  { name: "Alice", offset: -1 },
  { name: "bob", offset: 0 },
  { name: "Carol", offset: 1 },
  { name: "dave", offset: 6 },
  { name: "Eve", offset: 7 },
];

let w: World;
let table: Table;
let view: View;
let nameField = "";
let dueField = "";
let viewer: Profile;
let mondayViewer: Profile;

const within = (mode: DateOperand["mode"]): Filter => ({ conjunction: "and", items: [{ field_id: dueField, op: "is_within", value: { mode } as DateOperand }] });

async function names(filter: Filter, extra: { week_start?: number } = {}, as: Profile = w.owner): Promise<string[]> {
  const res = parse("QueryResponse", await as.run(() => recordsApi.query(view.id, { timezone: "UTC", transient: { filter }, ...extra })));
  return res.records.map((r) => r.values[nameField] as string);
}

/** The people whose date falls in `[first, last]`, in the order they were created. */
const between = (first: number, last: number) => PEOPLE.filter((p) => { const d = sunday + p.offset; return first <= d && d <= last; }).map((p) => p.name);

let sunday = 0;

beforeAll(async () => {
  w = await createWorld("Weeks");
  table = w.base.tables[0]!;
  nameField = table.primary_field_id;
  dueField = (await w.owner.run(() => schemaApi.createField(table.id, { name: "Due", type: "date", options: { include_time: false, date_format: "iso", time_format: "h24", timezone: null } }))).id;
  sunday = weekFirst(todayUtc(), 0);
  await w.owner.run(() =>
    recordsApi.create(table.id, { records: PEOPLE.map((p) => ({ values: { [nameField]: p.name, [dueField]: fromDay(sunday + p.offset) } })) }),
  );
  view = parse("View", await w.owner.run(() => api.views.create(table.id, { name: "By date", type: "grid", personal: false, config: null })));
  viewer = await newUser(w.owner, "weeks-sunday");
  mondayViewer = await newUser(w.owner, "weeks-monday");
  await joinBase(w.owner, w.baseId, viewer, "viewer");
  await joinBase(w.owner, w.baseId, mondayViewer, "viewer");
  expect(parse("User", await mondayViewer.run(() => api.auth.updateMe({ week_start: 1 }))).week_start).toBe(1);
});

describe("the week start", () => {
  it("is Sunday unless the request or the profile says otherwise", async () => {
    const first = (ws: 0 | 1) => weekFirst(todayUtc(), ws);
    const sundayWeek = between(first(0), first(0) + 6);
    const mondayWeek = between(first(1), first(1) + 6);
    expect(sundayWeek).not.toEqual(mondayWeek);
    const f = within("this_calendar_week");

    expect(await names(f, {}, viewer)).toEqual(sundayWeek);
    expect(await names(f, { week_start: 1 }, viewer)).toEqual(mondayWeek);
    expect(await names(f, { week_start: 0 }, viewer)).toEqual(sundayWeek);
    // The profile applies when the request names none, and the request wins over it.
    expect(await names(f, {}, mondayViewer)).toEqual(mondayWeek);
    expect(await names(f, { week_start: 0 }, mondayViewer)).toEqual(sundayWeek);
  });

  it("is refused when it is neither 0 nor 1, on the profile and on a request", async () => {
    expectError(await failure(w.owner.run(() => recordsApi.query(view.id, { timezone: "UTC", week_start: 2, transient: { filter: within("this_calendar_week") } }))), 400, "bad_request");
    expectError(await failure(viewer.run(() => api.auth.updateMe({ week_start: 7 }))), 400, "bad_request");
  });
});

describe("weeks and months relative to today", () => {
  it.each([0, 1] as const)("this, next and last calendar week, for weeks that start on %i", async (ws) => {
    const first = weekFirst(todayUtc(), ws);
    expect(await names(within("this_calendar_week"), { week_start: ws })).toEqual(between(first, first + 6));
    expect(await names(within("next_calendar_week"), { week_start: ws })).toEqual(between(first + 7, first + 13));
    expect(await names(within("last_calendar_week"), { week_start: ws })).toEqual(between(first - 7, first - 1));
  });

  it("next and last calendar month are the whole of that month", async () => {
    const now = new Date();
    const monthStart = (shift: number) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1) / DAY;
    // One person on each side of the month boundaries around today, dated by month rather than week.
    const month = await w.owner.run(() => api.tables.create(w.baseId, "Months"));
    const date = (await w.owner.run(() => schemaApi.createField(month.id, { name: "When", type: "date", options: { include_time: false, date_format: "iso", time_format: "h24", timezone: null } }))).id;
    const days: [string, number][] = [
      ["two months ago", monthStart(-1) - 1 - 20],
      ["last month, first day", monthStart(-1)],
      ["last month, last day", monthStart(0) - 1],
      ["this month", monthStart(0) + 3],
      ["next month, first day", monthStart(1)],
      ["next month, last day", monthStart(2) - 1],
      ["in two months", monthStart(2)],
    ];
    await w.owner.run(() => recordsApi.create(month.id, { records: days.map(([n, d]) => ({ values: { [month.primary_field_id]: n, [date]: fromDay(d) } })) }));
    const grid = parse("View", await w.owner.run(() => api.views.create(month.id, { name: "Months", type: "grid", personal: false, config: null })));
    const ask = async (mode: DateOperand["mode"]) => parse("QueryResponse", await w.owner.run(() => recordsApi.query(grid.id, { timezone: "UTC", transient: { filter: { conjunction: "and", items: [{ field_id: date, op: "is_within", value: { mode } as DateOperand }] } } }))).records.map((r) => r.values[month.primary_field_id]);
    expect(await ask("next_calendar_month")).toEqual(["next month, first day", "next month, last day"]);
    expect(await ask("last_calendar_month")).toEqual(["last month, first day", "last month, last day"]);
    expect(await ask("this_calendar_month")).toEqual(["this month"]);
  });
});

describe("everywhere a filter is computed", () => {
  it("applies the week start to the summary bar, with the profile's as the default", async () => {
    const first = (ws: 0 | 1) => weekFirst(todayUtc(), ws);
    const count = async (as: Profile, weekStart?: number) =>
      parse("AggregationsResponse", await as.run(() => recordsApi.aggregations(view.id, { timezone: "UTC", weekStart, transient: { filter: within("this_calendar_week"), summaries: { [nameField]: "filled" } } }))).values[nameField];
    expect(await count(viewer)).toBe(between(first(0), first(0) + 6).length);
    expect(await count(viewer, 1)).toBe(between(first(1), first(1) + 6).length);
    expect(await count(mondayViewer)).toBe(between(first(1), first(1) + 6).length);
    expect(await count(mondayViewer, 0)).toBe(between(first(0), first(0) + 6).length);
    expectError(await failure(viewer.run(() => recordsApi.aggregations(view.id, { timezone: "UTC", weekStart: 3, transient: { filter: within("this_calendar_week") } }))), 400, "bad_request");
  });

  it("applies the week start to the group-by endpoint behind aggregate_records", async () => {
    const saved = parse("View", await w.owner.run(() => api.views.create(table.id, { name: "Next week", type: "grid", personal: false, config: { ...view.config, filter: within("next_calendar_week") } })));
    const first = (ws: 0 | 1) => weekFirst(todayUtc(), ws);
    const counted = async (as: Profile, weekStart?: number) => {
      const res = await as.run(() => http.post<{ record_count: number }>(`/api/tables/${table.id}/aggregate`, { view: saved.id, timezone: "UTC", ...(weekStart === undefined ? {} : { week_start: weekStart }) }));
      return res.record_count;
    };
    expect(await counted(viewer)).toBe(between(first(0) + 7, first(0) + 13).length);
    expect(await counted(viewer, 1)).toBe(between(first(1) + 7, first(1) + 13).length);
    expect(await counted(mondayViewer)).toBe(between(first(1) + 7, first(1) + 13).length);
    expectError(await failure(viewer.run(() => http.post(`/api/tables/${table.id}/aggregate`, { view: saved.id, week_start: 5 }))), 400, "bad_request");
    await w.owner.run(() => api.views.remove(saved.id));
  });

  it("works in a saved view's filter, which a reader sees through their own week start", async () => {
    const saved = parse("View", await w.owner.run(() => api.views.update(view.id, { config: { ...view.config, filter: within("next_calendar_week") } })));
    const read = async (as: Profile) => parse("QueryResponse", await as.run(() => recordsApi.query(saved.id, { timezone: "UTC" }))).records.map((r) => r.values[nameField]);
    const first = (ws: 0 | 1) => weekFirst(todayUtc(), ws);
    expect(await read(viewer)).toEqual(between(first(0) + 7, first(0) + 13));
    expect(await read(mondayViewer)).toEqual(between(first(1) + 7, first(1) + 13));
    await w.owner.run(() => api.views.update(view.id, { config: { ...view.config, filter: null } }));
  });
});
