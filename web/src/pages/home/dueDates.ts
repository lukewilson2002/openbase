/**
 * How Home says when something is due (HOME-6): relative words, from the server's own idea of today so the row and the
 * `overdue` flag never disagree. Overdue dates say how long ago; the rest say Today, Tomorrow, a weekday within the week,
 * or the date, with the time of day when the date has one.
 */
import type { HomeDue } from "@/api/types";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_MS = 86_400_000;

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y ?? 1970, m ?? 1, d ?? 1];
}

const dayNumber = (day: string): number => {
  const [y, m, d] = parts(day);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
};

/** "9:00 am" from the server's `HH:MM`. */
export function clockWords(time: string): string {
  const [h = 0, mi = 0] = time.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mi).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

export function dueWords(due: Pick<HomeDue, "date" | "time" | "has_time" | "overdue">, today: string): string {
  const ahead = dayNumber(due.date) - dayNumber(today);
  let day: string;
  if (ahead < -1) day = `${-ahead} days ago`;
  else if (ahead === -1) day = "Yesterday";
  else if (ahead === 0) day = "Today";
  else if (ahead === 1) day = "Tomorrow";
  else if (ahead < 7) {
    const [y, m, d] = parts(due.date);
    day = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  } else {
    const [y, m, d] = parts(due.date);
    day = `${MONTHS[m - 1]} ${d}${y === parts(today)[0] ? "" : `, ${y}`}`;
  }
  return due.has_time && due.time ? `${day}, ${clockWords(due.time)}` : day;
}
