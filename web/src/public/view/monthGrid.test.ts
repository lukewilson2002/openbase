import { describe, expect, it } from "vitest";
import type { TableRecord } from "@/api/types";
import { resolveDateFields } from "@/views/common/dateFields";
import { field } from "@/test/fields";
import { chipsByDay, cursorOf, monthDays, monthTitle, shiftMonth } from "./monthGrid";

const dateOpts = { include_time: false, date_format: "iso", time_format: "h24", timezone: null } as const;
const start = field("date", dateOpts, { id: "f_start", name: "Start" });
const end = field("date", dateOpts, { id: "f_end", name: "End" });
const when = field("date", { ...dateOpts, include_time: true, timezone: "UTC" }, { id: "f_when", name: "When" });
const rec = (id: string, values: Record<string, unknown>) => ({ id, values }) as unknown as TableRecord;

describe("month layout", () => {
  it("shows six weeks from the Sunday on or before the 1st", () => {
    const days = monthDays({ year: 2026, month: 3 }); // March 1, 2026 is a Sunday
    expect(days).toHaveLength(42);
    expect(days[0]).toBe("2026-03-01");
    expect(days[41]).toBe("2026-04-11");
    // February 2026 starts on a Sunday too; May 2026 starts on a Friday.
    expect(monthDays({ year: 2026, month: 5 })[0]).toBe("2026-04-26");
  });

  it("moves between months across year ends", () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth({ year: 2026, month: 3 }, 0)).toEqual({ year: 2026, month: 3 });
    expect(cursorOf("2026-03-12")).toEqual({ year: 2026, month: 3 });
    expect(monthTitle({ year: 2026, month: 3 })).toBe("March 2026");
  });
});

describe("records on days", () => {
  const days = monthDays({ year: 2026, month: 3 });
  const title = (r: TableRecord) => r.id.toUpperCase();

  it("puts a one-day record on its day and a ranged one on every day of the range", () => {
    const dates = resolveDateFields([start, end], "f_start", "f_end")!;
    const chips = chipsByDay([rec("a", { f_start: "2026-03-10" }), rec("b", { f_start: "2026-03-10", f_end: "2026-03-12" }), rec("c", {})], dates, "UTC", days, title, { b: "blue" });
    expect([...chips.keys()].sort()).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
    expect(chips.get("2026-03-10")?.map((c) => c.title)).toEqual(["A", "B"]);
    expect(chips.get("2026-03-12")?.map((c) => c.title)).toEqual(["B"]);
    expect(chips.get("2026-03-11")?.[0]?.color).toBe("blue");
  });

  it("skips days that are not shown and records without a start", () => {
    const dates = resolveDateFields([start, end], "f_start", "f_end")!;
    const chips = chipsByDay([rec("a", { f_start: "2026-02-20", f_end: "2026-03-02" }), rec("z", { f_start: "2027-01-01" })], dates, "UTC", days, title, {});
    expect([...chips.keys()].sort()).toEqual(["2026-03-01", "2026-03-02"]);
  });

  it("shows the time of day on the first day of a timed record", () => {
    const dates = resolveDateFields([when], "f_when", null)!;
    const chips = chipsByDay([rec("a", { f_when: "2026-03-10T09:30:00.000Z" })], dates, "UTC", days, title, {});
    expect(chips.get("2026-03-10")).toEqual([{ id: "a", title: "A", time: "09:30", color: undefined }]);
  });
});
