import { describe, expect, it } from "vitest";
import { daysUntilPurge, relativeTime } from "./relativeTime";

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const H = 3600_000;
const D = 24 * H;

describe("relativeTime", () => {
  it("picks the largest whole unit", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
    expect(relativeTime(NOW - 3 * H, NOW)).toBe("3 hours ago");
    expect(relativeTime(NOW - D, NOW)).toBe("yesterday");
    expect(relativeTime(NOW - 3 * D, NOW)).toBe("3 days ago");
    expect(relativeTime(NOW - 14 * D, NOW)).toBe("2 weeks ago");
    expect(relativeTime(NOW - 90 * D, NOW)).toBe("3 months ago");
    expect(relativeTime(NOW + 2 * H, NOW)).toBe("in 2 hours");
  });
});

describe("daysUntilPurge", () => {
  it("counts the retention days left, rounding up, never negative", () => {
    expect(daysUntilPurge(NOW, 30, NOW)).toBe(30);
    expect(daysUntilPurge(NOW - 29 * D - H, 30, NOW)).toBe(1);
    expect(daysUntilPurge(NOW - 31 * D, 30, NOW)).toBe(0);
  });
});
