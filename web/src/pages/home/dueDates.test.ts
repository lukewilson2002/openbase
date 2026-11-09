import { describe, expect, it } from "vitest";
import { clockWords, dueWords } from "./dueDates";

const due = (date: string, over: { time?: string } = {}) => ({ date, overdue: false, has_time: !!over.time, time: over.time ?? null });

describe("dueWords", () => {
  const today = "2026-11-08";
  it("says how long ago an overdue date was", () => {
    expect(dueWords(due("2026-11-07"), today)).toBe("Yesterday");
    expect(dueWords(due("2026-11-05"), today)).toBe("3 days ago");
    expect(dueWords(due("2026-10-09"), today)).toBe("30 days ago");
  });

  it("says Today, Tomorrow, then the weekday within the week, then the date", () => {
    expect(dueWords(due("2026-11-08"), today)).toBe("Today");
    expect(dueWords(due("2026-11-09"), today)).toBe("Tomorrow");
    expect(dueWords(due("2026-11-12"), today)).toBe("Thursday");
    expect(dueWords(due("2026-11-14"), today)).toBe("Saturday");
    expect(dueWords(due("2026-11-15"), today)).toBe("Nov 15");
    expect(dueWords(due("2027-01-02"), "2026-12-30")).toBe("Saturday");
  });

  it("adds the time of day for a date-time", () => {
    expect(dueWords(due("2026-11-08", { time: "09:00" }), today)).toBe("Today, 9:00 am");
    expect(dueWords(due("2026-11-07", { time: "14:30" }), today)).toBe("Yesterday, 2:30 pm");
    expect(clockWords("00:05")).toBe("12:05 am");
    expect(clockWords("12:00")).toBe("12:00 pm");
  });
});
