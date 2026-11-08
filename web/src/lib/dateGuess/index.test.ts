import { describe, expect, it } from "vitest";
import { ymdToIso } from "@/lib/cells/dates";
import { cutSpan, guessDate, restorePhrase, type DateContext, type DateGuess } from "./index";

// Saturday, November 7, 2026, 15:00 UTC: the date in the spec's Home mockup.
const SAT = Date.UTC(2026, 10, 7, 15, 0);

function ctx(over: Partial<DateContext> = {}): DateContext {
  return { now: SAT, timeZone: "UTC", weekStart: 0, ...over };
}

function guess(text: string, over: Partial<DateContext> = {}): DateGuess {
  const g = guessDate(text, ctx(over));
  if (!g) throw new Error(`no date found in ${JSON.stringify(text)}`);
  return g;
}

const day = (text: string, over: Partial<DateContext> = {}): string => ymdToIso(guess(text, over).date);
const at = (y: number, m: number, d: number, h = 0, mi = 0): number => Date.UTC(y, m - 1, d, h, mi);

describe("day words", () => {
  it.each([
    ["today", "2026-11-07", "today"],
    ["Today", "2026-11-07", "today"],
    ["TODAY", "2026-11-07", "today"],
    ["tonight", "2026-11-07", "tonight"],
    ["tomorrow", "2026-11-08", "tomorrow"],
    ["tmrw", "2026-11-08", "tomorrow"],
    ["Tomorrow", "2026-11-08", "tomorrow"],
  ])("%s", (text, date, kind) => {
    const g = guess(text);
    expect(ymdToIso(g.date)).toBe(date);
    expect(g.kind).toBe(kind);
    expect(g.time).toBeNull();
    expect(g.value).toBe(date);
    expect(g.rest).toBe("");
  });

  it("leaves tonight without an invented time", () => {
    expect(guess("tonight").value).toBe("2026-11-07");
  });
});

describe("weekday names", () => {
  // From Saturday: a bare weekday is the next one after today.
  it.each([
    ["Sunday", "2026-11-08"],
    ["Monday", "2026-11-09"],
    ["Tuesday", "2026-11-10"],
    ["Wednesday", "2026-11-11"],
    ["Thursday", "2026-11-12"],
    ["Friday", "2026-11-13"],
    ["friday", "2026-11-13"],
    ["FRIDAY", "2026-11-13"],
    ["Mon", "2026-11-09"],
    ["mon", "2026-11-09"],
    ["Tue", "2026-11-10"],
    ["Tues", "2026-11-10"],
    ["Thu", "2026-11-12"],
    ["Thur", "2026-11-12"],
    ["Thurs", "2026-11-12"],
    ["Fri", "2026-11-13"],
    ["fri", "2026-11-13"],
    ["Sun", "2026-11-08"],
    ["Wed", "2026-11-11"],
  ])("%s", (text, date) => {
    expect(day(text)).toBe(date);
    expect(guess(text).kind).toBe("weekday");
  });

  it("a weekday that is today means a week from today, and says so", () => {
    const g = guess("Saturday");
    expect(ymdToIso(g.date)).toBe("2026-11-14");
    expect(g.ambiguity).toContain("weekday-is-today");
    expect(guess("Friday").ambiguity).not.toContain("weekday-is-today");
  });

  it("reads Sat, Sun, Wed and May as words unless capitalised", () => {
    for (const text of ["I sat down", "the sun is out", "they wed in June", "you may attend", "5 may be late"]) {
      expect(guessDate(text, ctx())).toBeNull();
    }
    expect(day("Sat")).toBe("2026-11-14");
    expect(day("Sun")).toBe("2026-11-08");
    expect(day("Wed")).toBe("2026-11-11");
    expect(day("May 5")).toBe("2027-05-05");
  });

  describe("this and next", () => {
    it("this Friday is the first Friday on or after today", () => {
      expect(day("this Friday", { now: at(2026, 11, 6, 9) })).toBe("2026-11-06");
      expect(day("this Friday", { now: at(2026, 11, 7, 9) })).toBe("2026-11-13");
      expect(day("this Monday", { now: at(2026, 11, 9, 9) })).toBe("2026-11-09");
      expect(guess("this friday").kind).toBe("this-weekday");
    });

    // [today, weekStart, "next Friday"]: the Friday of the calendar week after today's.
    it.each([
      ["2026-11-01", 0, "2026-11-13"], // Sunday, week Nov 1 to 7
      ["2026-11-02", 0, "2026-11-13"],
      ["2026-11-06", 0, "2026-11-13"], // Friday itself
      ["2026-11-07", 0, "2026-11-13"], // Saturday, last day of the week
      ["2026-11-08", 0, "2026-11-20"], // Sunday starts a new week
      ["2026-11-01", 1, "2026-11-06"], // Sunday ends the Monday-start week of Oct 26 to Nov 1
      ["2026-11-02", 1, "2026-11-13"], // Monday starts a week
      ["2026-11-06", 1, "2026-11-13"],
      ["2026-11-07", 1, "2026-11-13"],
      ["2026-11-08", 1, "2026-11-13"], // Sunday ends the week of Nov 2 to 8
      ["2026-11-09", 1, "2026-11-20"],
    ] as const)("next Friday on %s with week start %i is %s", (today, weekStart, expected) => {
      const [y, m, d] = today.split("-").map(Number) as [number, number, number];
      expect(day("next Friday", { now: at(y, m, d, 12), weekStart })).toBe(expected);
    });

    it("the week start moves 'next Sunday' by a whole week", () => {
      expect(day("next Sunday", { weekStart: 0 })).toBe("2026-11-08");
      expect(day("next Sunday", { weekStart: 1 })).toBe("2026-11-15");
      expect(day("next Monday", { weekStart: 0 })).toBe("2026-11-09");
      expect(day("next Monday", { weekStart: 1 })).toBe("2026-11-09");
      expect(day("next Saturday", { weekStart: 0 })).toBe("2026-11-14");
    });

    it("tolerates extra spaces and capitals", () => {
      expect(day("Next   fri")).toBe("2026-11-13");
      expect(guess("NEXT FRIDAY").kind).toBe("next-weekday");
    });

    it("keeps 'next' with the phrase when removing it", () => {
      expect(guess("Plan the offsite next Friday").rest).toBe("Plan the offsite");
    });

    it("does not read 'next' as part of another word", () => {
      const g = guess("context Friday");
      expect(g.phrase).toBe("Friday");
      expect(g.kind).toBe("weekday");
    });
  });
});

describe("month and day", () => {
  it.each([
    ["Nov 14", "2026-11-14"],
    ["nov 14", "2026-11-14"],
    ["NOV 14", "2026-11-14"],
    ["Nov. 14", "2026-11-14"],
    ["November 14", "2026-11-14"],
    ["Nov 14th", "2026-11-14"],
    ["Nov 1st", "2027-11-01"],
    ["Nov 2nd", "2027-11-02"],
    ["Nov 3rd", "2027-11-03"],
    ["14 Nov", "2026-11-14"],
    ["14 November", "2026-11-14"],
    ["14th Nov", "2026-11-14"],
    ["14th of Nov", "2026-11-14"],
    ["14 of November", "2026-11-14"],
    ["Dec 25", "2026-12-25"],
    ["Jan 5", "2027-01-05"],
    ["Feb 1", "2027-02-01"],
    ["Mar 3", "2027-03-03"],
    ["Apr 30", "2027-04-30"],
    ["May 5", "2027-05-05"],
    ["Jun 6", "2027-06-06"],
    ["June 6", "2027-06-06"],
    ["Jul 4", "2027-07-04"],
    ["July 4", "2027-07-04"],
    ["Aug 8", "2027-08-08"],
    ["Sep 9", "2027-09-09"],
    ["Sept 9", "2027-09-09"],
    ["September 9", "2027-09-09"],
    ["Oct 31", "2027-10-31"],
    ["31 Dec", "2026-12-31"],
    ["Nov 14 2027", "2027-11-14"],
    ["Nov 14, 2027", "2027-11-14"],
    ["14 Nov 2027", "2027-11-14"],
    ["14 Nov, 2027", "2027-11-14"],
    ["November 14th, 2027", "2027-11-14"],
  ])("%s", (text, date) => {
    expect(day(text)).toBe(date);
    expect(guess(text).kind).toBe("month-day");
    expect(guess(text).dateFormat).toBe("friendly");
  });

  it("today counts, yesterday rolls to next year", () => {
    expect(day("Nov 7")).toBe("2026-11-07");
    expect(day("Nov 6")).toBe("2027-11-06");
  });

  it("an explicit year stays where it was put, even in the past", () => {
    expect(day("Nov 6 2026")).toBe("2026-11-06");
    expect(day("Jan 1 2020")).toBe("2020-01-01");
    expect(day("Nov 14 2030")).toBe("2030-11-14");
  });

  it("waits for the next leap year for Feb 29", () => {
    expect(day("Feb 29")).toBe("2028-02-29");
    expect(day("Feb 29", { now: at(2028, 2, 28, 12) })).toBe("2028-02-29");
    expect(day("Feb 29", { now: at(2028, 3, 1, 12) })).toBe("2032-02-29");
    expect(day("Feb 29 2028")).toBe("2028-02-29");
  });

  it.each(["Feb 30", "Nov 31", "Apr 31", "Nov 32", "Nov 0", "32 Nov", "0 Nov", "Feb 29 2027", "Feb 30 2028", "Nov 100"])("%s is not a date", (text) => {
    expect(guessDate(text, ctx())).toBeNull();
  });

  it.each(["Nov", "November", "Novel 14", "Novembers 14", "Marching 3", "Nov 14-16", "Nov 14.5", "Nov 142", "Decks 3", "Nov x"])("%s is not a date", (text) => {
    expect(guessDate(text, ctx())).toBeNull();
  });

  it("a number that is not a year after the day stays in the text", () => {
    const g = guess("Nov 14 1030 meeting");
    expect(g.phrase).toBe("Nov 14");
    expect(g.rest).toBe("1030 meeting");
  });
});

describe("year and month rollover", () => {
  it("a late-December date reads next year's January", () => {
    const now = at(2026, 12, 31, 23, 30);
    expect(day("Jan 1", { now })).toBe("2027-01-01");
    expect(day("Dec 31", { now })).toBe("2026-12-31");
    expect(day("Dec 30", { now })).toBe("2027-12-30");
    expect(day("tomorrow", { now })).toBe("2027-01-01");
  });

  it("an early-January date reads last December as next year", () => {
    const now = at(2027, 1, 1, 0, 10);
    expect(day("Dec 31", { now })).toBe("2027-12-31");
    expect(day("12/31", { now })).toBe("2027-12-31");
    expect(day("Jan 1", { now })).toBe("2027-01-01");
  });

  it("tomorrow crosses month ends and leap days", () => {
    expect(day("tomorrow", { now: at(2026, 11, 30, 12) })).toBe("2026-12-01");
    expect(day("tomorrow", { now: at(2027, 2, 28, 12) })).toBe("2027-03-01");
    expect(day("tomorrow", { now: at(2028, 2, 28, 12) })).toBe("2028-02-29");
    expect(day("tomorrow", { now: at(2028, 2, 29, 12) })).toBe("2028-03-01");
    expect(day("tomorrow", { now: at(2026, 12, 31, 12) })).toBe("2027-01-01");
  });

  it("weekdays cross month and year ends", () => {
    const now = at(2026, 12, 30, 12); // Wednesday
    expect(day("Friday", { now })).toBe("2027-01-01");
    expect(day("next Friday", { now })).toBe("2027-01-08");
    expect(day("Wednesday", { now })).toBe("2027-01-06");
  });
});

describe("numeric dates", () => {
  it.each([
    ["11/14", "2026-11-14", "us"],
    ["14/11", "2026-11-14", "european"],
    ["1/5", "2027-01-05", "us"],
    ["12/31", "2026-12-31", "us"],
    ["31/12", "2026-12-31", "european"],
    ["11/14/2026", "2026-11-14", "us"],
    ["11/14/26", "2026-11-14", "us"],
    ["25/03/2026", "2026-03-25", "european"],
    ["03/25/2026", "2026-03-25", "us"],
    ["01/02/2026", "2026-01-02", "us"],
    ["2/29/2028", "2028-02-29", "us"],
    ["11/7", "2026-11-07", "us"],
  ])("%s", (text, date, format) => {
    const g = guess(text);
    expect(ymdToIso(g.date)).toBe(date);
    expect(g.dateFormat).toBe(format);
    expect(g.kind).toBe("numeric");
  });

  it("reads month first when both numbers could be either, and says so", () => {
    const g = guess("3/4");
    expect(ymdToIso(g.date)).toBe("2027-03-04");
    expect(g.ambiguity).toContain("day-month");
    expect(guess("3/3").ambiguity).not.toContain("day-month");
    expect(guess("11/14").ambiguity).not.toContain("day-month");
    expect(guess("25/03/2026").ambiguity).not.toContain("day-month");
  });

  it.each(["13/13", "13/13/2026", "2/30", "2/29/2027", "0/5", "5/0", "1/2/3/4", "a/b", "11/14/", "11//14", "1/2 cup", "3/4 of the budget", "1/2 hour", "Project 3/4 complete", "Call Dana 2/3 done", "score 7/10", "Rated 4/5", "step 2/5", "page 3/4", "example.com/11/14", "/11/14", "11/14/20267", "1/1/1850"])(
    "%s is not a date",
    (text) => {
      expect(guessDate(text, ctx())).toBeNull();
    },
  );

  it("a two-digit year far ahead is last century's, a near one this century's", () => {
    expect(day("Born 3/4/85")).toBe("1985-03-04");
    expect(day("1/2/99")).toBe("1999-01-02");
    expect(day("11/14/26")).toBe("2026-11-14");
    expect(day("1/2/46")).toBe("2046-01-02");
    expect(day("1/2/47")).toBe("1947-01-02");
    expect(day("1/2/47", { now: at(2040, 1, 1, 12) })).toBe("2047-01-02");
    // A year written in full is never moved.
    expect(day("3/4/2085")).toBe("2085-03-04");
  });

  it("a trailing full stop or comma is not part of the date", () => {
    expect(guess("see 11/14.").rest).toBe("see.");
    expect(guess("on 11/14, then").rest).toBe("then");
  });
});

describe("ISO dates", () => {
  it("reads a date, with and without a time", () => {
    const d = guess("2026-11-14");
    expect(d.value).toBe("2026-11-14");
    expect(d.dateFormat).toBe("iso");
    expect(d.kind).toBe("iso");
    const dt = guess("2026-11-14T10:00");
    expect(dt.value).toBe("2026-11-14T10:00:00.000Z");
    expect(dt.timeFormat).toBe("h24");
    expect(guess("2026-11-14 10:00").value).toBe("2026-11-14T10:00:00.000Z");
    expect(guess("2026-11-14T10:00:30").value).toBe("2026-11-14T10:00:30.000Z");
    expect(guess("2026-11-14T10:00:30.250Z").value).toBe("2026-11-14T10:00:30.000Z");
  });

  it("applies a UTC offset, and shows the wall clock in the person's zone", () => {
    expect(guess("2026-11-14T10:00:00Z").value).toBe("2026-11-14T10:00:00.000Z");
    expect(guess("2026-11-14T10:00:00+02:00").value).toBe("2026-11-14T08:00:00.000Z");
    expect(guess("2026-11-14T10:00:00-0500").value).toBe("2026-11-14T15:00:00.000Z");
    expect(guess("2026-11-14T10:00:00+02").value).toBe("2026-11-14T08:00:00.000Z");
    const tokyo = guess("2026-11-14T23:30:00-05:00", { timeZone: "Asia/Tokyo" });
    expect(tokyo.value).toBe("2026-11-15T04:30:00.000Z");
    expect(ymdToIso(tokyo.date)).toBe("2026-11-15");
    expect(tokyo.time).toEqual({ h: 13, mi: 30 });
  });

  it("interprets an offset-free time in the person's zone", () => {
    expect(guess("2026-11-14T10:00", { timeZone: "America/New_York" }).value).toBe("2026-11-14T15:00:00.000Z");
  });

  it.each(["2026-13-01", "2026-02-30", "2026-11-14T25:00", "2026-11-14T10:61", "2026-11-14T10:00+25:00", "2026-1-14", "12026-11-14", "2026-11-145", "0000-01-01"])("%s is not read", (text) => {
    // A malformed date is not a date, and the digits around a good one are not either.
    const g = guessDate(text, ctx());
    expect(g === null || g.phrase !== text).toBe(true);
  });

  it("is not triggered by a phone-like run of digits", () => {
    expect(guessDate("555-1234", ctx())).toBeNull();
  });
});

describe("times", () => {
  // Time alone from Saturday 15:00 UTC: later today, else tomorrow.
  it.each([
    ["9am", "2026-11-08T09:00:00.000Z", "meridiem"],
    ["9 am", "2026-11-08T09:00:00.000Z", "meridiem"],
    ["9AM", "2026-11-08T09:00:00.000Z", "meridiem"],
    ["9a.m.", "2026-11-08T09:00:00.000Z", "meridiem"],
    ["9:30am", "2026-11-08T09:30:00.000Z", "meridiem"],
    ["5pm", "2026-11-07T17:00:00.000Z", "meridiem"],
    ["5 pm", "2026-11-07T17:00:00.000Z", "meridiem"],
    ["5:45 p.m.", "2026-11-07T17:45:00.000Z", "meridiem"],
    ["12pm", "2026-11-08T12:00:00.000Z", "meridiem"],
    ["12am", "2026-11-08T00:00:00.000Z", "meridiem"],
    ["12:30am", "2026-11-08T00:30:00.000Z", "meridiem"],
    ["12:30pm", "2026-11-08T12:30:00.000Z", "meridiem"],
    ["11:59pm", "2026-11-07T23:59:00.000Z", "meridiem"],
    ["1am", "2026-11-08T01:00:00.000Z", "meridiem"],
    ["noon", "2026-11-08T12:00:00.000Z", "noon"],
    ["14:30", "2026-11-08T14:30:00.000Z", "clock"],
    ["16:00", "2026-11-07T16:00:00.000Z", "clock"],
    ["23:59", "2026-11-07T23:59:00.000Z", "clock"],
    ["0:05", "2026-11-08T00:05:00.000Z", "clock"],
    ["00:00", "2026-11-08T00:00:00.000Z", "clock"],
  ])("%s", (text, value, form) => {
    const g = guess(text);
    expect(g.value).toBe(value);
    expect(g.kind).toBe("time");
    expect(g.rest).toBe("");
    expect(g.timeFormat).toBe(form === "clock" ? "h24" : "h12");
  });

  it("a time that has just passed means tomorrow, one minute ahead means today", () => {
    expect(guess("3pm").value).toBe("2026-11-08T15:00:00.000Z");
    expect(guess("3:01pm").value).toBe("2026-11-07T15:01:00.000Z");
    expect(guess("2:59pm").value).toBe("2026-11-08T14:59:00.000Z");
  });

  it("a clock time that could be 12-hour is flagged", () => {
    expect(guess("5:30").ambiguity).toContain("am-pm");
    expect(guess("14:30").ambiguity).not.toContain("am-pm");
    expect(guess("0:30").ambiguity).not.toContain("am-pm");
    expect(guess("5:30pm").ambiguity).not.toContain("am-pm");
  });

  it.each(["13pm", "0am", "0pm", "9:60am", "24:00", "25:00", "10:00:00", "9", "at 9", "1:2", "930", "9 a", "9ampm", "9amazing", "v1:30x", "1.30pm"])("%s is not a time", (text) => {
    expect(guessDate(text, ctx())).toBeNull();
  });
});

describe("a date and a time together", () => {
  it.each([
    ["tomorrow 9am", "2026-11-08T09:00:00.000Z"],
    ["tomorrow at 9am", "2026-11-08T09:00:00.000Z"],
    ["tomorrow, 9am", "2026-11-08T09:00:00.000Z"],
    ["tomorrow @ 9am", "2026-11-08T09:00:00.000Z"],
    ["tomorrow@9am", "2026-11-08T09:00:00.000Z"],
    ["9am tomorrow", "2026-11-08T09:00:00.000Z"],
    ["at 9am tomorrow", "2026-11-08T09:00:00.000Z"],
    ["9am on Friday", "2026-11-13T09:00:00.000Z"],
    ["Friday at 2pm", "2026-11-13T14:00:00.000Z"],
    ["Friday 14:30", "2026-11-13T14:30:00.000Z"],
    ["next Friday at noon", "2026-11-13T12:00:00.000Z"],
    ["Nov 14 9am", "2026-11-14T09:00:00.000Z"],
    ["Nov 14 at 14:30", "2026-11-14T14:30:00.000Z"],
    ["Nov 14, 9:15 pm", "2026-11-14T21:15:00.000Z"],
    ["14 Nov 9am", "2026-11-14T09:00:00.000Z"],
    ["9am Nov 14", "2026-11-14T09:00:00.000Z"],
    ["11/14 3pm", "2026-11-14T15:00:00.000Z"],
    ["11/14/2027 3pm", "2027-11-14T15:00:00.000Z"],
    ["Nov 14 2027 3pm", "2027-11-14T15:00:00.000Z"],
    ["today at 9am", "2026-11-07T09:00:00.000Z"], // an explicit day is not moved by the time having passed
    ["tonight at 9pm", "2026-11-07T21:00:00.000Z"],
  ])("%s", (text, value) => {
    const g = guess(text);
    expect(g.value).toBe(value);
    expect(g.phrase).toBe(text);
    expect(g.rest).toBe("");
  });

  it("is one phrase: the whole of 'Nov 14 at 9am' leaves the title", () => {
    const g = guess("Dinner with Dana Nov 14 at 9am");
    expect(g.rest).toBe("Dinner with Dana");
    expect(g.phrase).toBe("Nov 14 at 9am");
  });

  it("does not join a date and a time that other words separate", () => {
    const g = guess("Nov 14 call Dana at 9am");
    expect(g.phrase).toBe("Nov 14");
    expect(g.time).toBeNull();
    expect(g.rest).toBe("call Dana at 9am");
    expect(g.ambiguity).toContain("more-phrases");
  });

  it("does not take a time for a year or the other way round", () => {
    expect(guess("Nov 14 2027").value).toBe("2027-11-14");
    expect(guess("Nov 14 20:27").time).toEqual({ h: 20, mi: 27 });
  });
});

describe("prepositions and tidying the text", () => {
  it.each([
    ["Call Dana tomorrow", "Call Dana", "tomorrow"],
    ["Call Dana tomorrow.", "Call Dana.", "tomorrow"],
    ["Call Dana tomorrow!", "Call Dana!", "tomorrow"],
    ["Call Dana tomorrow about the invoice", "Call Dana about the invoice", "tomorrow"],
    ["tomorrow call Dana", "call Dana", "tomorrow"],
    ["Tomorrow: call Dana", "call Dana", "Tomorrow"],
    ["Tomorrow, call Dana", "call Dana", "Tomorrow"],
    ["Tomorrow - call Dana", "call Dana", "Tomorrow"],
    ["Call Dana, tomorrow", "Call Dana", "tomorrow"],
    ["Call Dana - tomorrow", "Call Dana", "tomorrow"],
    ["Call Dana, tomorrow, about the invoice", "Call Dana, about the invoice", "tomorrow"],
    ["Call Dana tomorrow, about the invoice", "Call Dana, about the invoice", "tomorrow"],
    ["Send the invoice by Friday", "Send the invoice", "by Friday"],
    ["Send the invoice on Friday", "Send the invoice", "on Friday"],
    ["Send the invoice before Friday", "Send the invoice", "before Friday"],
    ["Send the invoice until Friday", "Send the invoice", "until Friday"],
    ["Invoice due Nov 14", "Invoice", "due Nov 14"],
    ["Invoice due by Nov 14", "Invoice", "due by Nov 14"],
    ["Invoice Due: Nov 14", "Invoice Due", "Nov 14"],
    ["Meet Dana at 9am", "Meet Dana", "at 9am"],
    ["Meet Dana @ 9am", "Meet Dana", "@ 9am"],
    ["Meet Dana @9am", "Meet Dana", "@9am"],
    ["Dinner at 7pm on Friday", "Dinner", "at 7pm on Friday"],
    ["Meet at the station Friday", "Meet at the station", "Friday"],
    ["Pay rent (Friday)", "Pay rent ()", "Friday"],
    ["  Pay rent tomorrow  ", "  Pay rent", "tomorrow"],
    ["tomorrow", "", "tomorrow"],
    ["by Friday", "", "by Friday"],
    ["Buy milk tomorrow\nand eggs", "Buy milk\nand eggs", "tomorrow"],
    ["Buy milk\ntomorrow and eggs", "Buy milk\nand eggs", "tomorrow"],
    ["Buy milk\nand eggs tomorrow", "Buy milk\nand eggs", "tomorrow"],
    ["Plan\n\nFriday standup", "Plan\n\nstandup", "Friday"],
  ])("%j leaves %j", (text, rest, phrase) => {
    const g = guess(text);
    expect(g.rest).toBe(rest);
    expect(g.phrase).toBe(phrase);
    expect(text.slice(g.start, g.end)).toBe(g.phrase);
    expect(g.text).toBe(text);
  });

  it("does not take a preposition that belongs to other words", () => {
    expect(guess("Look at the plan tomorrow").rest).toBe("Look at the plan");
    expect(guess("Stand by me tomorrow").rest).toBe("Stand by me");
    expect(guess("Written by Dana Friday").rest).toBe("Written by Dana");
  });
});

describe("putting the words back", () => {
  const samples = [
    "Call Dana tomorrow",
    "Call Dana tomorrow.",
    "tomorrow call Dana",
    "Tomorrow, call Dana",
    "Call Dana, tomorrow",
    "Call Dana, tomorrow, about the invoice",
    "Send the invoice by Friday",
    "Dinner at 7pm on Friday",
    "Buy milk\ntomorrow and eggs",
    "  Pay rent tomorrow  ",
    "Invoice due Nov 14",
    "tomorrow",
    "Plan the offsite next Friday please",
    "Call Dana tomorrow at 9am about 11/14",
  ];

  it.each(samples)("an untouched title comes back exactly: %j", (text) => {
    const g = guess(text);
    expect(restorePhrase(g, g.rest)).toBe(text);
  });

  it("puts the phrase back where it was after more typing", () => {
    const g = guess("Call Dana tomorrow about the invoice");
    expect(restorePhrase(g, "Call Dana about the invoice now")).toBe("Call Dana tomorrow about the invoice now");
    expect(restorePhrase(g, "Call Dana")).toBe("Call Dana tomorrow");
    expect(restorePhrase(g, "")).toBe("tomorrow");
    expect(restorePhrase(g, "Ca")).toBe("Ca tomorrow");
  });

  it("puts a phrase back at the front and the end", () => {
    const front = guess("tomorrow call Dana");
    expect(restorePhrase(front, "call Dana now")).toBe("tomorrow call Dana now");
    const end = guess("Call Dana by Friday");
    expect(restorePhrase(end, "Call Dana and Sam")).toBe("Call Dana by Friday and Sam");
  });

  it("does not double a space or add one before punctuation", () => {
    const g = guess("Call Dana tomorrow.");
    expect(restorePhrase(g, "Call Dana, please.")).toBe("Call Dana tomorrow, please.");
  });
});

describe("cutSpan", () => {
  it("returns the seam", () => {
    expect(cutSpan("ab cd ef", 3, 5)).toEqual({ rest: "ab ef", at: 2 });
    expect(cutSpan("cd ef", 0, 2)).toEqual({ rest: "ef", at: 0 });
    expect(cutSpan("ab cd", 3, 5)).toEqual({ rest: "ab", at: 2 });
  });
});

describe("more than one phrase", () => {
  it("takes the last phrase that holds a date, and flags the rest", () => {
    const g = guess("Friday meeting moved to Monday");
    expect(ymdToIso(g.date)).toBe("2026-11-09");
    expect(g.ambiguity).toContain("more-phrases");
    expect(g.rest).toBe("Friday meeting moved to");
  });

  it("prefers a date over a bare time", () => {
    const g = guess("Call at 9am about Nov 14");
    expect(g.phrase).toBe("Nov 14");
    expect(g.time).toBeNull();
    expect(g.ambiguity).toContain("more-phrases");
  });

  it("with only times, takes the last", () => {
    const g = guess("9am or 5pm");
    expect(g.phrase).toBe("5pm");
  });

  it("a single phrase is not flagged", () => {
    expect(guess("Call Dana Friday").ambiguity).toEqual([]);
  });
});

describe("text with no date in it", () => {
  it.each([
    "",
    "   ",
    "Call Dana",
    "Buy milk",
    "Fridays are busy",
    "Friday's meeting",
    "Reply to Friday’s email",
    "unfriday",
    "tomorrows plan",
    "todays",
    "Nov",
    "May",
    "2026",
    "2024",
    "1,000",
    "$600",
    "call 870 555 0100",
    "version 2.0",
    "3.5 stars",
    "1:30:00",
    "mailto:friday@example.com",
    "dana@friday.com",
    "https://example.com/friday",
    "tomorrow-ish",
    "Mon-Fri",
  ])("%j", (text) => {
    expect(guessDate(text, ctx())).toBeNull();
  });
});

describe("time zones", () => {
  // Sunday 03:30 UTC: still Saturday evening in the Americas, already Sunday afternoon in Asia.
  const now = Date.UTC(2026, 10, 8, 3, 30);
  const zones: [string, string][] = [
    ["UTC", "2026-11-08"],
    ["America/New_York", "2026-11-07"],
    ["America/Los_Angeles", "2026-11-07"],
    ["Europe/London", "2026-11-08"],
    ["Asia/Tokyo", "2026-11-08"],
    ["Pacific/Kiritimati", "2026-11-08"], // UTC+14
    ["Pacific/Pago_Pago", "2026-11-07"], // UTC-11
    ["Pacific/Auckland", "2026-11-08"],
    ["Asia/Kolkata", "2026-11-08"], // half-hour offset
  ];

  it.each(zones)("today in %s is %s", (timeZone, date) => {
    expect(day("today", { now, timeZone })).toBe(date);
  });

  it("tomorrow and weekdays follow the person's day, not UTC's", () => {
    expect(day("tomorrow", { now, timeZone: "America/New_York" })).toBe("2026-11-08");
    expect(day("tomorrow", { now, timeZone: "UTC" })).toBe("2026-11-09");
    // Saturday evening in New York: "Sunday" is tomorrow; in UTC it is already Sunday, so a week away.
    expect(day("Sunday", { now, timeZone: "America/New_York" })).toBe("2026-11-08");
    expect(day("Sunday", { now, timeZone: "UTC" })).toBe("2026-11-15");
    expect(day("Nov 7", { now, timeZone: "America/New_York" })).toBe("2026-11-07");
    expect(day("Nov 7", { now, timeZone: "UTC" })).toBe("2027-11-07");
  });

  it("the new year arrives at different moments", () => {
    const instant = Date.UTC(2027, 0, 1, 3, 30);
    expect(day("today", { now: instant, timeZone: "America/New_York" })).toBe("2026-12-31");
    expect(day("today", { now: instant, timeZone: "UTC" })).toBe("2027-01-01");
    expect(day("Dec 31", { now: instant, timeZone: "America/New_York" })).toBe("2026-12-31");
    expect(day("Dec 31", { now: instant, timeZone: "UTC" })).toBe("2027-12-31");
    expect(day("tomorrow", { now: instant, timeZone: "Pacific/Kiritimati" })).toBe("2027-01-02");
  });

  it("a time alone compares against the person's clock", () => {
    // 22:30 Saturday in New York: 9pm has passed; 11pm has not.
    expect(guess("9pm", { now, timeZone: "America/New_York" }).value).toBe("2026-11-09T02:00:00.000Z");
    expect(guess("11pm", { now, timeZone: "America/New_York" }).value).toBe("2026-11-08T04:00:00.000Z");
    // 19:30 in Los Angeles.
    expect(guess("9pm", { now, timeZone: "America/Los_Angeles" }).value).toBe("2026-11-08T05:00:00.000Z");
  });

  it("a date-time becomes the instant in the person's zone, the date stays the date", () => {
    const tokyo = guess("Nov 14 9am", { timeZone: "Asia/Tokyo" });
    expect(tokyo.value).toBe("2026-11-14T00:00:00.000Z");
    expect(ymdToIso(tokyo.date)).toBe("2026-11-14");
    expect(tokyo.time).toEqual({ h: 9, mi: 0 });
    expect(guess("Nov 14 9am", { timeZone: "America/New_York" }).value).toBe("2026-11-14T14:00:00.000Z");
    expect(guess("Nov 14 9am", { timeZone: "Asia/Kolkata" }).value).toBe("2026-11-14T03:30:00.000Z");
    expect(guess("Nov 14 9am", { timeZone: "Pacific/Kiritimati" }).value).toBe("2026-11-13T19:00:00.000Z");
  });

  it("a date alone is the same date everywhere", () => {
    for (const [timeZone] of zones) expect(guess("Nov 14", { timeZone }).value).toBe("2026-11-14");
  });

  it("an unknown zone reads as UTC", () => {
    expect(day("today", { now, timeZone: "Mars/Olympus" })).toBe("2026-11-08");
    expect(day("today", { now, timeZone: "" })).toBe("2026-11-08");
  });

  describe("daylight saving time", () => {
    const springNY = Date.UTC(2026, 2, 7, 17, 0); // Sat Mar 7 12:00 EST, the day before clocks jump
    const ny = "America/New_York";

    it("a time inside the spring-forward gap lands just after it", () => {
      expect(guess("tomorrow 2:30am", { now: springNY, timeZone: ny }).value).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
      expect(guess("tomorrow 2:00am", { now: springNY, timeZone: ny }).value).toBe("2026-03-08T07:00:00.000Z"); // 03:00 EDT
      expect(guess("tomorrow 3:30am", { now: springNY, timeZone: ny }).value).toBe("2026-03-08T07:30:00.000Z");
      expect(guess("tomorrow 1:59am", { now: springNY, timeZone: ny }).value).toBe("2026-03-08T06:59:00.000Z");
    });

    it("offsets change across the jump", () => {
      expect(guess("today 9am", { now: springNY, timeZone: ny }).value).toBe("2026-03-07T14:00:00.000Z"); // EST
      expect(guess("tomorrow 9am", { now: springNY, timeZone: ny }).value).toBe("2026-03-08T13:00:00.000Z"); // EDT
      expect(guess("Mon 9am", { now: springNY, timeZone: ny }).value).toBe("2026-03-09T13:00:00.000Z");
    });

    it("an ambiguous time in the fall-back hour takes the first one", () => {
      const fall = Date.UTC(2026, 9, 31, 16, 0); // Sat Oct 31 12:00 EDT
      expect(guess("tomorrow 1:30am", { now: fall, timeZone: ny }).value).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT
      expect(guess("tomorrow 2:30am", { now: fall, timeZone: ny }).value).toBe("2026-11-01T07:30:00.000Z"); // 02:30 EST
      expect(guess("tomorrow 9am", { now: fall, timeZone: ny }).value).toBe("2026-11-01T14:00:00.000Z"); // EST
    });

    it("tomorrow is a calendar day even when that day is 23 or 25 hours long", () => {
      expect(day("tomorrow", { now: springNY, timeZone: ny })).toBe("2026-03-08");
      expect(day("tomorrow", { now: Date.UTC(2026, 2, 8, 17, 0), timeZone: ny })).toBe("2026-03-09");
      expect(day("tomorrow", { now: Date.UTC(2026, 9, 31, 16, 0), timeZone: ny })).toBe("2026-11-01");
      expect(day("tomorrow", { now: Date.UTC(2026, 10, 1, 17, 0), timeZone: ny })).toBe("2026-11-02");
    });

    it("a time alone on the day clocks change compares against the real wall clock", () => {
      // 00:30 EST on spring-forward Sunday: 1am is still ahead, 2:30am sits in the gap.
      const justAfterMidnight = Date.UTC(2026, 2, 8, 5, 30);
      expect(guess("1am", { now: justAfterMidnight, timeZone: ny }).value).toBe("2026-03-08T06:00:00.000Z");
      // 03:10 EDT: the 2am slot is gone, so 2:30am is before now and means tomorrow.
      expect(guess("2:30am", { now: Date.UTC(2026, 2, 8, 7, 10), timeZone: ny }).value).toBe("2026-03-09T06:30:00.000Z");
    });

    it("works in the southern hemisphere and with half-hour changes", () => {
      const sydneyNow = Date.UTC(2026, 9, 3, 0, 0); // Sat Oct 3 11:00 AEDT? DST began Oct 4, so 10:00 AEST
      expect(guess("tomorrow 9am", { now: sydneyNow, timeZone: "Australia/Sydney" }).value).toBe("2026-10-03T22:00:00.000Z"); // 09:00 AEDT
      expect(guess("today 9am", { now: sydneyNow, timeZone: "Australia/Sydney" }).value).toBe("2026-10-02T23:00:00.000Z"); // 09:00 AEST
      const london = Date.UTC(2026, 2, 28, 12, 0); // Sat Mar 28, clocks go forward at 01:00 Sunday
      expect(guess("tomorrow 1:30am", { now: london, timeZone: "Europe/London" }).value).toBe("2026-03-29T01:30:00.000Z"); // 02:30 BST
    });
  });
});

describe("the clock is injected", () => {
  it("accepts a Date or milliseconds and gives the same answer", () => {
    const a = guessDate("tomorrow 9am", { now: new Date(SAT), timeZone: "Asia/Tokyo", weekStart: 0 });
    const b = guessDate("tomorrow 9am", { now: SAT, timeZone: "Asia/Tokyo", weekStart: 0 });
    expect(a).toEqual(b);
  });

  it("is deterministic and leaves its inputs alone", () => {
    const c = ctx({ timeZone: "Asia/Tokyo" });
    const frozen = JSON.stringify(c);
    const first = guessDate("Fri 5pm", c);
    const second = guessDate("Fri 5pm", c);
    expect(first).toEqual(second);
    expect(JSON.stringify(c)).toBe(frozen);
  });

  it("does not read the machine clock", () => {
    const g1 = guessDate("tomorrow", ctx({ now: Date.UTC(2001, 8, 9, 12) }));
    expect(g1 && ymdToIso(g1.date)).toBe("2001-09-10");
  });
});
