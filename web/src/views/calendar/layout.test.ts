import { beforeEach, describe, expect, it, vi } from "vitest";
import { firstDayOf, layoutOf, loadCalendarState, loadWeekStart, localeFirstDay, saveCalendarState, saveWeekStart, viewType } from "./layout";

beforeEach(() => localStorage.clear());

describe("viewType and layoutOf", () => {
  it("gives week and day an hourly grid for date-times and a grid of days for dates", () => {
    expect(viewType("week", "timed")).toBe("timeGridWeek");
    expect(viewType("week", "days")).toBe("dayGridWeek");
    expect(viewType("day", "timed")).toBe("timeGridDay");
    expect(viewType("day", "days")).toBe("dayGridDay");
    expect(viewType("month", "days")).toBe("dayGridMonth");
  });

  it("makes the list show the stretch of time the layout before it did", () => {
    expect(viewType("list", "days")).toBe("listMonth");
    expect(viewType("list", "days", "week")).toBe("listWeek");
    expect(viewType("list", "timed", "day")).toBe("listDay");
  });

  it("reads FullCalendar's names back, whatever the grid", () => {
    expect(layoutOf("timeGridWeek")).toEqual({ layout: "week", unit: "week" });
    expect(layoutOf("dayGridWeek")).toEqual({ layout: "week", unit: "week" });
    expect(layoutOf("dayGridDay")).toEqual({ layout: "day", unit: "day" });
    expect(layoutOf("listWeek")).toEqual({ layout: "list", unit: "week" });
    expect(layoutOf("multiMonthYear")).toBeNull();
  });
});

describe("remembered layout and date", () => {
  it("keeps one entry per view", () => {
    saveCalendarState("a", { layout: "week", unit: "week", date: "2026-03-12" });
    saveCalendarState("b", { layout: "list", unit: "day", date: "2026-04-01" });
    expect(loadCalendarState("a")).toEqual({ layout: "week", unit: "week", date: "2026-03-12" });
    expect(loadCalendarState("b")).toEqual({ layout: "list", unit: "day", date: "2026-04-01" });
    expect(loadCalendarState("c")).toBeNull();
  });

  it("ignores garbage and works without storage", () => {
    localStorage.setItem("ob-calendar-state", JSON.stringify({ a: { layout: "year", unit: "month", date: "2026-03-12" }, b: { layout: "day", unit: "day", date: "soon" } }));
    expect(loadCalendarState("a")).toBeNull();
    expect(loadCalendarState("b")).toBeNull();
    localStorage.setItem("ob-calendar-state", "{not json");
    expect(loadCalendarState("a")).toBeNull();
    const broken = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => saveCalendarState("a", { layout: "day", unit: "day", date: "2026-03-12" })).not.toThrow();
    broken.mockRestore();
  });
});

describe("first day of the week", () => {
  it("follows the language: Sunday in the US, Monday in much of Europe, Saturday in Egypt", () => {
    expect(localeFirstDay("en-US")).toBe(0);
    expect(localeFirstDay("en-GB")).toBe(1);
    expect(localeFirstDay("de-DE")).toBe(1);
    expect(localeFirstDay("ar-EG")).toBe(6);
    expect(localeFirstDay(undefined)).toBe(0);
    expect(localeFirstDay("not a tag")).toBe(0);
  });

  it("takes the viewer's own choice over the language", () => {
    expect(firstDayOf("auto", "en-GB")).toBe(1);
    expect(firstDayOf("0", "en-GB")).toBe(0);
    expect(firstDayOf("6", "en-US")).toBe(6);
  });

  it("remembers the choice, and forgets it for 'follow my language'", () => {
    expect(loadWeekStart()).toBe("auto");
    saveWeekStart("1");
    expect(loadWeekStart()).toBe("1");
    saveWeekStart("auto");
    expect(localStorage.getItem("ob-calendar-week-start")).toBeNull();
    localStorage.setItem("ob-calendar-week-start", "9");
    expect(loadWeekStart()).toBe("auto");
  });
});
