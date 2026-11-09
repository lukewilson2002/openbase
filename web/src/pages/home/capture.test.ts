import { afterEach, describe, expect, it } from "vitest";
import type { BaseSchema, Field, WorkspaceSummary } from "@/api/types";
import { guessDate } from "@/lib/dateGuess";
import { field, makeTable } from "@/test/fields";
import { makeSchema } from "@/test/utils";
import { collectionOptions, dateChip, dayWords, firstLineOf, guessLine, headerDate, homeDateField, keepUnsentText, lastCaptured, pickFileTarget, pickTarget, rememberCaptured, splitCapture, unsentText } from "./capture";

afterEach(() => localStorage.clear());

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const due = field("date", { include_time: false, date_format: "friendly", time_format: "h12", timezone: null }, { id: "fld_due", name: "Due" });
const dueAt = field("date", { include_time: true, date_format: "friendly", time_format: "h12", timezone: null }, { id: "fld_at", name: "Start" });
const dateOnly = due as Extract<Field, { type: "date" }>;
const dateTime = dueAt as Extract<Field, { type: "date" }>;

// Saturday, November 7 2026 at 7:30 pm in Los Angeles is already Sunday the 8th in UTC.
const NIGHT = Date.UTC(2026, 10, 8, 3, 30);
const ctx = (timeZone: string) => ({ now: NIGHT, timeZone, weekStart: 0 as const });
const chipFor = (text: string, field: Extract<Field, { type: "date" }>, zone: string) => dateChip(guessLine(text, ctx(zone), null), field, ctx(zone));

describe("splitCapture", () => {
  it("takes the first line as the title and the rest as the page", () => {
    expect(splitCapture("Buy milk")).toEqual({ title: "Buy milk", page: "" });
    expect(splitCapture("  Plan trip \nLisbon in May\n\n- flights\n")).toEqual({ title: "Plan trip", page: "Lisbon in May\n\n- flights" });
    expect(splitCapture("   ")).toEqual({ title: "", page: "" });
  });

  it("reads a date phrase in the first line only", () => {
    expect(firstLineOf("Call Dana tomorrow\nnotes for Friday")).toEqual({ line: "Call Dana tomorrow", tail: "\nnotes for Friday" });
    expect(firstLineOf("one line")).toEqual({ line: "one line", tail: "" });
  });
});

describe("headerDate", () => {
  it("names today in the person's zone, not the machine's", () => {
    expect(headerDate(NIGHT, "America/Los_Angeles")).toBe("Saturday, November 7");
    expect(headerDate(NIGHT, "UTC")).toBe("Sunday, November 8");
    expect(headerDate(NIGHT, "Pacific/Auckland")).toBe("Sunday, November 8");
  });

  it("falls back to UTC for a zone that does not exist", () => {
    expect(headerDate(NIGHT, "Not/AZone")).toBe("Sunday, November 8");
  });
});

describe("dateChip", () => {
  it("turns a phrase into a chip and the value of the date property", () => {
    const chip = chipFor("Call Dana tomorrow", dateOnly, "UTC");
    expect(chip?.label).toBe("Due tomorrow");
    expect(chip?.value).toBe("2026-11-09");
    expect(chip?.guess.rest).toBe("Call Dana");
  });

  it("counts days in the person's zone: the same words are a day apart for someone still in Saturday", () => {
    expect(chipFor("Pay rent today", dateOnly, "America/Los_Angeles")?.value).toBe("2026-11-07");
    expect(chipFor("Pay rent today", dateOnly, "UTC")?.value).toBe("2026-11-08");
    expect(chipFor("Pay rent tomorrow", dateOnly, "America/Los_Angeles")?.value).toBe("2026-11-08");
  });

  it("writes a time as the instant it is in the person's zone, on a property that holds times", () => {
    const la = chipFor("Dentist tomorrow at 9am", dateTime, "America/Los_Angeles");
    expect(la?.label).toBe("Start: tomorrow · 9:00 am");
    expect(new Date(la!.value).getTime()).toBe(Date.UTC(2026, 10, 8, 17, 0));
    const tokyo = chipFor("Dentist tomorrow at 9am", dateTime, "Asia/Tokyo");
    expect(new Date(tokyo!.value).getTime()).toBe(Date.UTC(2026, 10, 9, 0, 0));
  });

  it("gives no chip for a time on a date-only property: the words stay in the title", () => {
    expect(chipFor("Dentist tomorrow at 9am", dateOnly, "UTC")).toBeNull();
    expect(chipFor("Call at 14:30", dateOnly, "UTC")).toBeNull();
  });

  it("stores midnight when a property that holds times is given a day", () => {
    const chip = chipFor("Review Friday", dateTime, "UTC");
    expect(new Date(chip!.value).getUTCHours()).toBe(0);
    expect(chip?.label).toBe("Start: Fri");
  });

  it("does not guess again a phrase the person took off", () => {
    expect(guessLine("Call Dana tomorrow", ctx("UTC"), "tomorrow")).toBeNull();
    expect(guessLine("Call Dana tomorrow", ctx("UTC"), "Friday")?.phrase).toBe("tomorrow");
  });

  it("says days in words next to today", () => {
    const today = { y: 2026, m: 11, d: 8 };
    expect(dayWords(today, today)).toBe("today");
    expect(dayWords({ y: 2026, m: 11, d: 9 }, today)).toBe("tomorrow");
    expect(dayWords({ y: 2026, m: 11, d: 11 }, today)).toBe("Wed");
    expect(dayWords({ y: 2026, m: 11, d: 15 }, today)).toBe("Nov 15");
    expect(dayWords({ y: 2027, m: 1, d: 2 }, today)).toBe("Jan 2, 2027");
  });

  it("round-trips through the date guess module for the words it cut out", () => {
    const g = guessDate("Send it by Friday", ctx("UTC"))!;
    expect(g.rest).toBe("Send it");
  });
});

describe("homeDateField", () => {
  it("is the collection's Home date when it is a plain date property, and nothing for a computed one", () => {
    const stamp = field("created_time", { include_time: true, date_format: "iso", time_format: "h24", timezone: null }, { id: "fld_stamp", name: "Added" });
    expect(homeDateField(makeTable([name, due], { home_date_field_id: "fld_due" }))?.id).toBe("fld_due");
    expect(homeDateField(makeTable([name, stamp], { home_date_field_id: "fld_stamp" }))).toBeNull();
    expect(homeDateField(makeTable([name, due]))).toBeNull();
    expect(homeDateField(undefined)).toBeNull();
  });
});

describe("where a capture goes", () => {
  const summary = (id: string, name: string) => ({ id, name, icon: null, color: "blue", record_count: 0, record_noun: "" });
  const workspace: WorkspaceSummary = {
    id: "wsp1",
    name: "Acme",
    color: "green",
    role: "owner",
    member_count: 1,
    pending_invite_count: 0,
    bases: [
      { id: "app1", workspace_id: "wsp1", name: "Top", color: "green", role: "editor", is_top_level: true, people: [], tables: [summary("tbl1", "Tasks"), summary("tbl2", "Scans")] },
      { id: "app2", workspace_id: "wsp1", name: "Read only", color: "blue", role: "commenter", is_top_level: false, people: [], tables: [summary("tbl9", "Secrets")] },
      { id: "app3", workspace_id: "wsp1", name: "Garden", color: "red", role: "creator", is_top_level: false, people: [], tables: [summary("tbl5", "Plants")] },
    ],
  };
  const count = field("number", { precision: 0, allow_negative: false }, { id: "fld_count", name: "Count" });
  const schema = (id: string, tables: BaseSchema["tables"]) => makeSchema("editor", { id, tables });
  const schemas = new Map([
    ["app1", schema("app1", [makeTable([name], { id: "tbl1", base_id: "app1" }), makeTable([count], { id: "tbl2", base_id: "app1", name: "Scans" })])],
    ["app3", schema("app3", [makeTable([name], { id: "tbl5", base_id: "app3", name: "Plants" })])],
  ]);

  it("lists collections the person can add to whose title is text, and says which folders it has yet to check", () => {
    const found = collectionOptions(workspace, schemas);
    expect(found.options.map((o) => `${o.name}${o.folder ? ` in ${o.folder}` : ""}`)).toEqual(["Tasks", "Plants in Garden"]);
    expect(found.pending).toEqual([]);
    expect(collectionOptions(workspace, new Map([["app1", schemas.get("app1")!]])).pending).toEqual(["app3"]);
  });

  it("lists every collection a draft can be filed into when titles may be any kind", () => {
    const found = collectionOptions(workspace, schemas, "any");
    expect(found.options.map((o) => o.name)).toEqual(["Tasks", "Scans", "Plants"]);
  });

  it("defaults to the last collection captured into, else Inbox: a first note is a draft, not a record nobody chose", () => {
    const found = collectionOptions(workspace, schemas);
    expect(pickTarget(null, { baseId: "app3", tableId: "tbl5" }, found, workspace)).toEqual({ kind: "collection", baseId: "app3", tableId: "tbl5" });
    expect(pickTarget(null, { baseId: "app3", tableId: "gone" }, found, workspace)).toEqual({ kind: "inbox" });
    expect(pickTarget(null, null, found, workspace)).toEqual({ kind: "inbox" });
    // The person's own pick wins, Inbox included.
    expect(pickTarget({ kind: "inbox" }, { baseId: "app3", tableId: "tbl5" }, found, workspace)).toEqual({ kind: "inbox" });
    expect(pickTarget({ kind: "collection", baseId: "app1", tableId: "tbl1" }, null, found, workspace)).toEqual({ kind: "collection", baseId: "app1", tableId: "tbl1" });
  });

  it("points filing at the pick, else the last collection captured into, else the first one there is, else nothing", () => {
    const found = collectionOptions(workspace, schemas, "any");
    expect(pickFileTarget({ baseId: "app1", tableId: "tbl2" }, { baseId: "app3", tableId: "tbl5" }, found, workspace)).toEqual({ baseId: "app1", tableId: "tbl2" });
    expect(pickFileTarget(null, { baseId: "app3", tableId: "tbl5" }, found, workspace)).toEqual({ baseId: "app3", tableId: "tbl5" });
    expect(pickFileTarget(null, null, found, workspace)).toEqual({ baseId: "app1", tableId: "tbl1" });
    expect(pickFileTarget(null, null, collectionOptions(workspace, new Map(), "any"), { ...workspace, bases: [] })).toBeNull();
  });

  it("trusts the remembered collection while its folder is still being checked, so the chip does not flash Inbox", () => {
    const waiting = collectionOptions(workspace, new Map());
    expect(pickTarget(null, { baseId: "app3", tableId: "tbl5" }, waiting, workspace)).toEqual({ kind: "collection", baseId: "app3", tableId: "tbl5" });
    expect(pickTarget(null, { baseId: "app3", tableId: "gone" }, waiting, workspace)).toEqual({ kind: "inbox" });
  });

  it("keeps unsent text per workspace on the device, and forgets it when it is emptied", () => {
    expect(unsentText("wsp1")).toBe("");
    keepUnsentText("wsp1", "Call Dana\nabout the quote");
    keepUnsentText("wsp2", "Other");
    expect(unsentText("wsp1")).toBe("Call Dana\nabout the quote");
    keepUnsentText("wsp1", "");
    expect(unsentText("wsp1")).toBe("");
    expect(unsentText("wsp2")).toBe("Other");
    keepUnsentText("wsp2", "");
    expect(localStorage.getItem("ob-capture-text")).toBeNull();
    localStorage.setItem("ob-capture-text", "not json");
    expect(unsentText("wsp1")).toBe("");
  });

  it("remembers the last collection per workspace", () => {
    expect(lastCaptured("wsp1")).toBeNull();
    rememberCaptured("wsp1", { baseId: "app1", tableId: "tbl1" });
    rememberCaptured("wsp2", { baseId: "app9", tableId: "tbl9" });
    expect(lastCaptured("wsp1")).toEqual({ baseId: "app1", tableId: "tbl1" });
    localStorage.setItem("ob-last-capture", "not json");
    expect(lastCaptured("wsp1")).toBeNull();
  });
});
