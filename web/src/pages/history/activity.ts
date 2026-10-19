/**
 * Shaping the History feed for reading: consecutive items on one record (on one day) become a
 * group, shown as one card, and the groups are sectioned by day in the person's time zone.
 */
import type { ActivityItem, ActivityPlace, ActivityRecord } from "@/api/types";

export interface ActivityGroup {
  /** Stable across loads: the id of the group's first item. */
  key: string;
  record: ActivityRecord;
  place: ActivityPlace;
  items: ActivityItem[];
}

export interface DaySection {
  /** `YYYY-MM-DD` in the person's time zone. */
  day: string;
  label: string;
  groups: ActivityGroup[];
}

/** The calendar day (`YYYY-MM-DD`) of a timestamp in `timeZone`. */
export function dayKey(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** "Today", "Yesterday", else "Friday, Oct 16" (with the year when it is not this one). */
export function dayLabel(day: string, now: number, timeZone: string): string {
  const today = dayKey(now, timeZone);
  if (day === today) return "Today";
  // Calendar arithmetic on the key itself, so a day with a clock change is still one day back.
  const before = new Date(`${today}T12:00:00Z`);
  before.setUTCDate(before.getUTCDate() - 1);
  if (day === before.toISOString().slice(0, 10)) return "Yesterday";
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "long", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(new Date(`${day}T12:00:00Z`));
}

/** Items in feed order, grouped while the record and the day stay the same. */
export function groupActivity(items: readonly ActivityItem[], timeZone: string): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let lastDay = "";
  for (const item of items) {
    const day = dayKey(item.created_at, timeZone);
    const last = groups.at(-1);
    if (last && day === lastDay && last.record.id === item.record.id) {
      last.items.push(item);
    } else {
      groups.push({ key: item.id, record: item.record, place: item.place, items: [item] });
    }
    lastDay = day;
  }
  return groups;
}

/** Groups sectioned by the day of their first item. */
export function sectionByDay(groups: readonly ActivityGroup[], now: number, timeZone: string): DaySection[] {
  const sections: DaySection[] = [];
  for (const group of groups) {
    const day = dayKey(group.items[0]!.created_at, timeZone);
    const last = sections.at(-1);
    if (last?.day === day) last.groups.push(group);
    else sections.push({ day, label: dayLabel(day, now, timeZone), groups: [group] });
  }
  return sections;
}
