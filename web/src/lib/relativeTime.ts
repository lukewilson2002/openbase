/** "3 days ago", "in 2 hours": coarse relative time for server timestamps (Unix milliseconds). */
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["week", 7 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = ms - now;
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return rtf.format(Math.trunc(diff / size), unit);
  }
  return "just now";
}

/** Whole days left until `deletedAt + retentionDays`, never below zero. */
export function daysUntilPurge(deletedAt: number, retentionDays: number, now: number = Date.now()): number {
  const left = deletedAt + retentionDays * 24 * 3600_000 - now;
  return Math.max(0, Math.ceil(left / (24 * 3600_000)));
}
