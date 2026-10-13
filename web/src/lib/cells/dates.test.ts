import { describe, expect, it } from "vitest";
import { formatStoredDate, fromInputValue, parseDate, readStoredDate, storeParsedDate, toInputValue, zonedParts, zonedToInstant } from "./dates";

const base = { include_time: false, date_format: "us", time_format: "h12", timezone: null } as const;

describe("formatStoredDate", () => {
  it("never shifts date-only values between zones", () => {
    for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"]) {
      expect(formatStoredDate("2026-10-12", base, tz)).toBe("10/12/2026");
    }
  });

  it("formats each date format", () => {
    expect(formatStoredDate("2026-10-12", { ...base, date_format: "european" }, "UTC")).toBe("12/10/2026");
    expect(formatStoredDate("2026-10-12", { ...base, date_format: "iso" }, "UTC")).toBe("2026-10-12");
    expect(formatStoredDate("2026-10-12", { ...base, date_format: "friendly" }, "UTC")).toBe("October 12, 2026");
  });

  it("shows instants in the viewer's zone, or the field's fixed zone", () => {
    const iso = "2026-10-12T23:30:00.000Z";
    const withTime = { ...base, include_time: true };
    expect(formatStoredDate(iso, withTime, "UTC")).toBe("10/12/2026 11:30pm");
    expect(formatStoredDate(iso, withTime, "Asia/Tokyo")).toBe("10/13/2026 8:30am");
    expect(formatStoredDate(iso, { ...withTime, timezone: "America/New_York" }, "Asia/Tokyo")).toBe("10/12/2026 7:30pm");
    expect(formatStoredDate(iso, { ...withTime, time_format: "h24" }, "UTC")).toBe("10/12/2026 23:30");
  });

  it("shows only the day for instants when the field has no time", () => {
    expect(formatStoredDate("2026-10-12T23:30:00.000Z", base, "Asia/Tokyo")).toBe("10/13/2026");
  });

  it("handles midnight and noon in 12 hour time", () => {
    const o = { ...base, include_time: true };
    expect(formatStoredDate("2026-01-01T00:05:00.000Z", o, "UTC")).toBe("1/1/2026 12:05am");
    expect(formatStoredDate("2026-01-01T12:00:00.000Z", o, "UTC")).toBe("1/1/2026 12:00pm");
  });

  it("returns empty text for unreadable input", () => {
    expect(formatStoredDate("nonsense", base, "UTC")).toBe("");
    expect(formatStoredDate(null, base, "UTC")).toBe("");
    expect(formatStoredDate("2026-02-31", base, "UTC")).toBe("");
  });
});

describe("zones", () => {
  it("converts wall-clock times to instants across DST", () => {
    // New York is UTC-5 in winter and UTC-4 in summer.
    expect(new Date(zonedToInstant({ y: 2026, m: 1, d: 15, h: 9, mi: 0, s: 0, ms: 0 }, "America/New_York")).toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(new Date(zonedToInstant({ y: 2026, m: 7, d: 15, h: 9, mi: 0, s: 0, ms: 0 }, "America/New_York")).toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("takes the earlier instant for an ambiguous fall-back time", () => {
    // 2026-11-01 01:30 happens twice in New York; the first is EDT (UTC-4).
    expect(new Date(zonedToInstant({ y: 2026, m: 11, d: 1, h: 1, mi: 30, s: 0, ms: 0 }, "America/New_York")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("moves a spring-forward gap time forward", () => {
    // 2026-03-08 02:30 does not exist in New York.
    const ms = zonedToInstant({ y: 2026, m: 3, d: 8, h: 2, mi: 30, s: 0, ms: 0 }, "America/New_York");
    const p = zonedParts(ms, "America/New_York");
    expect(p.h).toBe(3);
    expect(p.mi).toBe(30);
  });

  it("round-trips zonedParts", () => {
    const ms = Date.UTC(2026, 5, 1, 12, 34, 56);
    const p = zonedParts(ms, "Australia/Sydney");
    expect(zonedToInstant(p, "Australia/Sydney")).toBe(ms);
  });
});

describe("input values", () => {
  it("round-trips date and datetime-local values in the field zone", () => {
    const withTime = { ...base, include_time: true, timezone: "Europe/Berlin" };
    const iso = fromInputValue("2026-10-12T14:30", withTime, "UTC");
    expect(iso).toBe("2026-10-12T12:30:00.000Z");
    expect(toInputValue(iso, withTime, "UTC")).toBe("2026-10-12T14:30");
    expect(fromInputValue("2026-10-12", base, "UTC")).toBe("2026-10-12");
    expect(fromInputValue("garbage", base, "UTC")).toBeNull();
    expect(readStoredDate("2026-10-12")).toEqual({ kind: "date", ymd: { y: 2026, m: 10, d: 12 } });
  });
});

describe("parseDate", () => {
  const cases: [string, boolean, string][] = [
    ["2026-10-12", false, "date:2026-10-12"],
    ["2026/10/12", false, "date:2026-10-12"],
    ["10/12/2026", false, "date:2026-10-12"],
    ["12/10/2026", true, "date:2026-10-12"],
    ["October 12, 2026", false, "date:2026-10-12"],
    ["Oct 12 2026", false, "date:2026-10-12"],
    ["12 October 2026", false, "date:2026-10-12"],
    ["Mon, Oct 12, 2026", false, "date:2026-10-12"],
    ["1/2/26", false, "date:2026-01-02"],
    ["2026-10-12 2:30pm", false, "local:2026-10-12T14:30"],
    ["2026-10-12T14:30:15", false, "local:2026-10-12T14:30"],
    ["2026-10-12T14:30:15Z", false, "instant:2026-10-12T14:30:15.000Z"],
    ["2026-10-12T14:30:00+02:00", false, "instant:2026-10-12T12:30:00.000Z"],
    ["10/12/2026 12am", false, "local:2026-10-12T00:00"],
  ];
  it.each(cases)("parses %s", (input, european, expected) => {
    const p = parseDate(input, european);
    if (!p) throw new Error(`${input} did not parse`);
    const two = (n: number) => String(n).padStart(2, "0");
    const out =
      p.kind === "date"
        ? `date:${p.ymd.y}-${two(p.ymd.m)}-${two(p.ymd.d)}`
        : p.kind === "instant"
          ? `instant:${new Date(p.ms).toISOString()}`
          : `local:${p.local.y}-${two(p.local.m)}-${two(p.local.d)}T${two(p.local.h)}:${two(p.local.mi)}`;
    expect(out).toBe(expected);
  });

  it.each(["", "tomorrow", "2026-13-01", "2026-02-30", "10/12/2026 25:00", "10/12/2026 5", "hello world 2026"])("rejects %j", (input) => {
    expect(parseDate(input, false)).toBeNull();
  });

  it("stores parsed dates per field options", () => {
    const withTime = { ...base, include_time: true, timezone: "Asia/Tokyo" };
    expect(storeParsedDate(parseDate("2026-10-12 9:00am", false)!, withTime, "UTC")).toBe("2026-10-12T00:00:00.000Z");
    expect(storeParsedDate(parseDate("2026-10-12", false)!, withTime, "UTC")).toBe("2026-10-11T15:00:00.000Z");
    expect(storeParsedDate(parseDate("2026-10-12 9:00am", false)!, base, "UTC")).toBe("2026-10-12");
    // An instant stored into a date-only field becomes the day in the field zone.
    expect(storeParsedDate(parseDate("2026-10-12T23:30:00Z", false)!, { ...base, timezone: "Asia/Tokyo" }, "UTC")).toBe("2026-10-13");
  });
});
