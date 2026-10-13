import { describe, expect, it } from "vitest";
import type { DateOptions } from "@/api/types";
import { DAY_MS, padRange, readWall, recordSpan, wallIso, wallNow, wallToStored, wallYmd, ymdWall } from "./wallTime";

const dateOnly: DateOptions = { include_time: false, date_format: "iso", time_format: "h24", timezone: null };
const timed: DateOptions = { include_time: true, date_format: "iso", time_format: "h24", timezone: null };
const timedNY: DateOptions = { ...timed, timezone: "America/New_York" };

describe("wall time", () => {
  it("reads date-only values without any zone shift", () => {
    const w = readWall("2026-03-08", dateOnly, "Pacific/Auckland")!;
    expect(w).toEqual({ ms: Date.UTC(2026, 2, 8), dateOnly: true });
    expect(wallYmd(w.ms)).toBe("2026-03-08");
  });

  it("reads instants in the field's zone, else the viewer's", () => {
    // 2026-07-01T02:30Z is 22:30 the day before in New York (EDT), 11:30 in Tokyo.
    expect(wallIso(readWall("2026-07-01T02:30:00.000Z", timedNY, "Asia/Tokyo")!.ms)).toBe("2026-06-30T22:30:00");
    expect(wallIso(readWall("2026-07-01T02:30:00.000Z", timed, "Asia/Tokyo")!.ms)).toBe("2026-07-01T11:30:00");
  });

  it("truncates an instant to its date for date-only fields", () => {
    expect(readWall("2026-07-01T23:30:00.000Z", dateOnly, "America/New_York")).toEqual({ ms: Date.UTC(2026, 6, 1), dateOnly: true });
  });

  it("returns null for empty or unreadable values", () => {
    expect(readWall(null, dateOnly, "UTC")).toBeNull();
    expect(readWall("soon", dateOnly, "UTC")).toBeNull();
  });

  it("round-trips wall time back to the stored form", () => {
    expect(wallToStored(Date.UTC(2026, 2, 8), dateOnly, "UTC")).toBe("2026-03-08");
    const wall = readWall("2026-07-01T02:30:00.000Z", timedNY, "UTC")!.ms;
    expect(wallToStored(wall, timedNY, "UTC")).toBe("2026-07-01T02:30:00.000Z");
    const wall2 = readWall("2026-01-15T12:00:00.000Z", timed, "Europe/Berlin")!.ms;
    expect(wallToStored(wall2 + 3 * DAY_MS, timed, "Europe/Berlin")).toBe("2026-01-18T12:00:00.000Z");
  });

  it("keeps the wall-clock time across a DST change when moving by whole days", () => {
    // 09:00 New York on 2026-03-07 (EST) moved one day lands on 09:00 EDT = 13:00Z.
    const start = readWall("2026-03-07T14:00:00.000Z", timedNY, "UTC")!;
    expect(wallIso(start.ms)).toBe("2026-03-07T09:00:00");
    expect(wallToStored(start.ms + 2 * DAY_MS, timedNY, "UTC")).toBe("2026-03-09T13:00:00.000Z");
  });

  it("computes wall now in the viewer's zone and parses days", () => {
    expect(wallIso(wallNow("Asia/Tokyo", new Date("2026-05-01T20:00:00Z")))).toBe("2026-05-02T05:00:00");
    expect(ymdWall("2026-02-30")).not.toBeNull(); // Date.UTC rolls over; validity is the field editors' job
    expect(ymdWall("nope")).toBeNull();
  });
});

describe("recordSpan", () => {
  const start = { id: "s", opts: dateOnly };
  const end = { id: "e", opts: dateOnly };

  it("treats a date-only end as inclusive and exposes an exclusive end", () => {
    const s = recordSpan({ s: "2026-03-02", e: "2026-03-04" }, start, end, "UTC")!;
    expect(s).toEqual({ startMs: Date.UTC(2026, 2, 2), endMs: Date.UTC(2026, 2, 5), startDateOnly: true, hasEnd: true });
  });

  it("collapses a missing or earlier end to a single day / instant", () => {
    expect(recordSpan({ s: "2026-03-02" }, start, end, "UTC")).toMatchObject({ hasEnd: false, endMs: Date.UTC(2026, 2, 3) });
    expect(recordSpan({ s: "2026-03-02", e: "2026-03-01" }, start, end, "UTC")).toMatchObject({ hasEnd: false });
    const t = recordSpan({ s: "2026-03-02T10:00:00.000Z" }, { id: "s", opts: timed }, null, "UTC")!;
    expect(t.endMs).toBe(t.startMs);
    expect(t.hasEnd).toBe(false);
  });

  it("returns null without a start", () => {
    expect(recordSpan({ e: "2026-03-02" }, start, end, "UTC")).toBeNull();
  });
});

describe("padRange", () => {
  it("widens by whole days and rejects bad input", () => {
    expect(padRange("2026-03-01", "2026-03-31", 1)).toEqual({ from: "2026-02-28", to: "2026-04-01" });
    expect(padRange("x", "2026-03-31", 1)).toBeNull();
  });
});
