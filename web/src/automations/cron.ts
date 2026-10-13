/**
 * Schedule presets <-> cron expressions. The server accepts croner syntax (5 fields, or 6 with a
 * leading seconds field) and refuses anything that can fire more often than every 5 minutes; the
 * presets here always produce plain 5-field expressions that pass that check. Anything the preset
 * parser does not recognise stays a "custom" expression and is sent untouched.
 */

export type SchedulePreset =
  | { kind: "every_minutes"; minutes: number }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; day: number; hour: number; minute: number }
  | { kind: "monthly"; dayOfMonth: number; hour: number; minute: number }
  | { kind: "custom"; cron: string };

export type PresetKind = SchedulePreset["kind"];

/** Minutes that divide the hour evenly, so the gap never shrinks at the top of the hour (minimum 5). */
export const MINUTE_INTERVALS = [5, 10, 15, 20, 30] as const;

/** Index = cron day of week (0 is Sunday). */
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const PRESET_LABELS: Record<PresetKind, string> = {
  every_minutes: "Every few minutes",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom cron expression",
};

export const PRESET_KINDS: readonly PresetKind[] = ["every_minutes", "hourly", "daily", "weekly", "monthly", "custom"];

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.trunc(Number.isFinite(n) ? n : min)));

/** The expression for a preset (custom presets return their text as typed). */
export function buildCron(p: SchedulePreset): string {
  switch (p.kind) {
    case "every_minutes":
      return `*/${clamp(p.minutes, 5, 30)} * * * *`;
    case "hourly":
      return `${clamp(p.minute, 0, 59)} * * * *`;
    case "daily":
      return `${clamp(p.minute, 0, 59)} ${clamp(p.hour, 0, 23)} * * *`;
    case "weekly":
      return `${clamp(p.minute, 0, 59)} ${clamp(p.hour, 0, 23)} * * ${clamp(p.day, 0, 6)}`;
    case "monthly":
      return `${clamp(p.minute, 0, 59)} ${clamp(p.hour, 0, 23)} ${clamp(p.dayOfMonth, 1, 31)} * *`;
    case "custom":
      return p.cron;
  }
}

const INT = /^\d+$/;

function int(part: string | undefined, min: number, max: number): number | null {
  if (part === undefined || !INT.test(part)) return null;
  const n = Number(part);
  return n >= min && n <= max ? n : null;
}

/** Recognise the expressions `buildCron` produces; everything else is custom. */
export function parseCron(cron: string): SchedulePreset {
  const custom: SchedulePreset = { kind: "custom", cron };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return custom;
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (month !== "*") return custom;

  const step = /^\*\/(\d+)$/.exec(min);
  if (step && hour === "*" && dom === "*" && dow === "*") {
    const n = Number(step[1]);
    return (MINUTE_INTERVALS as readonly number[]).includes(n) ? { kind: "every_minutes", minutes: n } : custom;
  }
  const minute = int(min, 0, 59);
  if (minute === null) return custom;
  if (hour === "*" && dom === "*" && dow === "*") return { kind: "hourly", minute };
  const h = int(hour, 0, 23);
  if (h === null) return custom;
  if (dom === "*" && dow === "*") return { kind: "daily", hour: h, minute };
  if (dom === "*") {
    const d = int(dow, 0, 7);
    return d === null ? custom : { kind: "weekly", day: d % 7, hour: h, minute };
  }
  if (dow === "*") {
    const d = int(dom, 1, 31);
    return d === null ? custom : { kind: "monthly", dayOfMonth: d, hour: h, minute };
  }
  return custom;
}

/** Defaults when switching to a preset kind in the picker (the time of day carries over). */
export function defaultPreset(kind: PresetKind, from?: SchedulePreset): SchedulePreset {
  const hour = from && "hour" in from ? from.hour : 9;
  const minute = from && "minute" in from ? from.minute : 0;
  switch (kind) {
    case "every_minutes":
      return { kind, minutes: 15 };
    case "hourly":
      return { kind, minute };
    case "daily":
      return { kind, hour, minute };
    case "weekly":
      return { kind, day: from?.kind === "weekly" ? from.day : 1, hour, minute };
    case "monthly":
      return { kind, dayOfMonth: from?.kind === "monthly" ? from.dayOfMonth : 1, hour, minute };
    case "custom":
      return { kind, cron: from ? buildCron(from) : "0 9 * * *" };
  }
}

export const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "09:30" for a time input; parses back with `parseTime`. */
export function formatTime(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

export function parseTime(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  const suffix = n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** A sentence for a schedule, e.g. "Every Monday at 09:30". Custom expressions are quoted. */
export function describeCron(cron: string): string {
  const p = parseCron(cron);
  switch (p.kind) {
    case "every_minutes":
      return `Every ${p.minutes} minutes`;
    case "hourly":
      return p.minute === 0 ? "Every hour, on the hour" : `Every hour at ${pad2(p.minute)} minutes past`;
    case "daily":
      return `Every day at ${formatTime(p.hour, p.minute)}`;
    case "weekly":
      return `Every ${WEEKDAYS[p.day]} at ${formatTime(p.hour, p.minute)}`;
    case "monthly":
      return `On the ${ordinal(p.dayOfMonth)} of every month at ${formatTime(p.hour, p.minute)}`;
    case "custom":
      return `Cron ${cron.trim()}`;
  }
}
