import { describe, expect, it } from "vitest";
import { buildCron, defaultPreset, describeCron, formatTime, parseCron, parseTime, type SchedulePreset } from "./cron";

describe("buildCron", () => {
  it.each<[SchedulePreset, string]>([
    [{ kind: "every_minutes", minutes: 15 }, "*/15 * * * *"],
    [{ kind: "hourly", minute: 0 }, "0 * * * *"],
    [{ kind: "hourly", minute: 45 }, "45 * * * *"],
    [{ kind: "daily", hour: 9, minute: 30 }, "30 9 * * *"],
    [{ kind: "daily", hour: 0, minute: 0 }, "0 0 * * *"],
    [{ kind: "weekly", day: 1, hour: 8, minute: 5 }, "5 8 * * 1"],
    [{ kind: "weekly", day: 0, hour: 23, minute: 59 }, "59 23 * * 0"],
    [{ kind: "monthly", dayOfMonth: 15, hour: 6, minute: 0 }, "0 6 15 * *"],
    [{ kind: "custom", cron: "0 */2 * * *" }, "0 */2 * * *"],
  ])("%j -> %s", (preset, cron) => {
    expect(buildCron(preset)).toBe(cron);
  });

  it("clamps out-of-range values instead of producing an invalid expression", () => {
    expect(buildCron({ kind: "daily", hour: 31, minute: -4 })).toBe("0 23 * * *");
    expect(buildCron({ kind: "every_minutes", minutes: 1 })).toBe("*/5 * * * *");
    expect(buildCron({ kind: "monthly", dayOfMonth: 99, hour: 1, minute: 1 })).toBe("1 1 31 * *");
  });
});

describe("parseCron", () => {
  it("round-trips every preset", () => {
    const presets: SchedulePreset[] = [
      { kind: "every_minutes", minutes: 5 },
      { kind: "every_minutes", minutes: 30 },
      { kind: "hourly", minute: 7 },
      { kind: "daily", hour: 13, minute: 0 },
      { kind: "weekly", day: 6, hour: 22, minute: 15 },
      { kind: "monthly", dayOfMonth: 28, hour: 3, minute: 30 },
    ];
    for (const p of presets) expect(parseCron(buildCron(p))).toEqual(p);
  });

  it("reads Sunday written as 7 and extra whitespace", () => {
    expect(parseCron(" 0   9 * *  7 ")).toEqual({ kind: "weekly", day: 0, hour: 9, minute: 0 });
  });

  it("keeps anything else as custom, untouched", () => {
    for (const c of ["*/7 * * * *", "0 9 * * 1-5", "0 9 1 6 *", "0 0 9 * * *", "@daily", "0 9 1 * 1", "61 * * * *", "", "not a cron"]) {
      expect(parseCron(c)).toEqual({ kind: "custom", cron: c });
    }
  });
});

describe("defaultPreset", () => {
  it("keeps the time of day when switching kinds", () => {
    const daily = defaultPreset("daily", { kind: "daily", hour: 17, minute: 45 });
    expect(daily).toEqual({ kind: "daily", hour: 17, minute: 45 });
    expect(defaultPreset("weekly", daily)).toEqual({ kind: "weekly", day: 1, hour: 17, minute: 45 });
    expect(defaultPreset("monthly", daily)).toEqual({ kind: "monthly", dayOfMonth: 1, hour: 17, minute: 45 });
    expect(defaultPreset("hourly", daily)).toEqual({ kind: "hourly", minute: 45 });
  });

  it("custom starts from the current expression", () => {
    expect(defaultPreset("custom", { kind: "weekly", day: 2, hour: 4, minute: 5 })).toEqual({ kind: "custom", cron: "5 4 * * 2" });
  });
});

describe("time helpers", () => {
  it("formats and parses HH:MM", () => {
    expect(formatTime(9, 5)).toBe("09:05");
    expect(parseTime("09:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("9")).toBeNull();
  });
});

describe("describeCron", () => {
  it("reads like a sentence", () => {
    expect(describeCron("0 * * * *")).toBe("Every hour, on the hour");
    expect(describeCron("30 9 * * *")).toBe("Every day at 09:30");
    expect(describeCron("0 8 * * 1")).toBe("Every Monday at 08:00");
    expect(describeCron("0 8 1 * *")).toBe("On the 1st of every month at 08:00");
    expect(describeCron("0 8 22 * *")).toBe("On the 22nd of every month at 08:00");
    expect(describeCron("0 8 13 * *")).toBe("On the 13th of every month at 08:00");
    expect(describeCron("*/10 * * * *")).toBe("Every 10 minutes");
    expect(describeCron("0 9 * * 1-5")).toBe("Cron 0 9 * * 1-5");
  });
});
