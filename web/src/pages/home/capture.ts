/**
 * What Home's capture box decides before anything is written (HOME-3, HOME-4): which collections it can add to, where it
 * goes by default, how the text splits into a title and a page, and the date chip a phrase in the title becomes. All of it
 * is plain functions of their inputs (the clock and the time zone come in), so the rules are tested without a screen.
 */
import type { BaseSchema, Field, Table, WorkspaceSummary } from "@/api/types";
import { storeParsedDate, zonedParts, zonedToInstant, type YMD } from "@/lib/cells/dates";
import { guessDate, type DateGuess } from "@/lib/dateGuess";
import { canCreateRecords, isTextTitle, primaryField } from "./targets";

/** The browser's own zone, for people who have not set one. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ---- where it goes ---------------------------------------------------------------------------------------------------

export interface TableRef {
  baseId: string;
  tableId: string;
}

/** A collection, or the Inbox (a draft to file later). */
export type TargetChoice = { kind: "inbox" } | ({ kind: "collection" } & TableRef);

export interface CollectionOption extends TableRef {
  name: string;
  color: string | null;
  /** The folder's name when the collection is not in the workspace's top level. */
  folder: string | null;
}

export const INBOX_CHOICE: TargetChoice = { kind: "inbox" };

export const sameChoice = (a: TargetChoice, b: TargetChoice): boolean =>
  a.kind === b.kind && (a.kind === "inbox" || (b.kind === "collection" && a.baseId === b.baseId && a.tableId === b.tableId));

export interface CollectionOptions {
  options: CollectionOption[];
  /** Folders the person can add to whose schema has not arrived, so their collections' titles are not known yet. */
  pending: string[];
}

/**
 * The collections a capture can go to: the person can add records to the folder (Editor and up) and the collection's title is
 * a text property. A title's type lives in the folder's schema, which the workspace list does not carry, so a folder whose
 * schema is not in `schemas` yet is reported in `pending` instead of being guessed at.
 */
export function collectionOptions(workspace: WorkspaceSummary, schemas: ReadonlyMap<string, BaseSchema>): CollectionOptions {
  const options: CollectionOption[] = [];
  const pending: string[] = [];
  for (const base of workspace.bases) {
    if (!canCreateRecords(base.role) || base.tables.length === 0) continue;
    const schema = schemas.get(base.id);
    if (!schema) {
      pending.push(base.id);
      continue;
    }
    for (const summary of base.tables) {
      const table = schema.tables.find((t) => t.id === summary.id);
      const primary = table && primaryField(table);
      if (!table || !primary || !isTextTitle(primary)) continue;
      options.push({ baseId: base.id, tableId: table.id, name: summary.name, color: summary.color, folder: base.is_top_level ? null : base.name });
    }
  }
  return { options, pending };
}

/**
 * Where the box points: the person's pick, else the last collection captured into (while its folder's schema is still on
 * the way it is trusted, so the chip does not flash Inbox), else the first collection there is, else Inbox.
 */
export function pickTarget(chosen: TargetChoice | null, remembered: TableRef | null, found: CollectionOptions, workspace: WorkspaceSummary): TargetChoice {
  const listed = (ref: TableRef) => found.options.some((o) => o.baseId === ref.baseId && o.tableId === ref.tableId);
  if (chosen && (chosen.kind === "inbox" || listed(chosen))) return chosen;
  if (remembered) {
    const waiting = found.pending.includes(remembered.baseId) && workspace.bases.some((b) => b.id === remembered.baseId && b.tables.some((t) => t.id === remembered.tableId));
    if (listed(remembered) || waiting) return { kind: "collection", ...remembered };
  }
  const first = found.options[0];
  return first ? { kind: "collection", baseId: first.baseId, tableId: first.tableId } : INBOX_CHOICE;
}

const LAST_KEY = "ob-last-capture";

function readAll(): Record<string, TableRef> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, TableRef> = {};
    for (const [ws, ref] of Object.entries(parsed)) {
      const r = ref as Partial<TableRef> | null;
      if (r && typeof r.baseId === "string" && typeof r.tableId === "string") out[ws] = { baseId: r.baseId, tableId: r.tableId };
    }
    return out;
  } catch {
    return {};
  }
}

/** The collection this person last captured into in the workspace, on this device. */
export function lastCaptured(workspaceId: string): TableRef | null {
  return readAll()[workspaceId] ?? null;
}

export function rememberCaptured(workspaceId: string, ref: TableRef): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...readAll(), [workspaceId]: ref }));
  } catch {
    /* storage unavailable: the next visit starts from the first collection */
  }
}

// ---- the text --------------------------------------------------------------------------------------------------------

/** The first line is the title; every further line is the page. Blank lines around either are dropped. */
export function splitCapture(text: string): { title: string; page: string } {
  const trimmed = text.trim();
  const at = trimmed.indexOf("\n");
  if (at < 0) return { title: trimmed, page: "" };
  return { title: trimmed.slice(0, at).trim(), page: trimmed.slice(at + 1).trim() };
}

/** The text's first line and the lines after it, with their line break. A date phrase is read in the first line only. */
export function firstLineOf(text: string): { line: string; tail: string } {
  const at = text.indexOf("\n");
  return at < 0 ? { line: text, tail: "" } : { line: text.slice(0, at), tail: text.slice(at) };
}

// ---- the date chip ---------------------------------------------------------------------------------------------------

/** The date property a phrase can fill: the collection's Home date when it is a plain, writable date (computed ones are not). */
export function homeDateField(table: Table | undefined): Extract<Field, { type: "date" }> | null {
  const field = table?.fields.find((f) => f.id === table.home_date_field_id);
  return field?.type === "date" ? field : null;
}

export interface DateChip {
  label: string;
  /** The cell value to write. */
  value: string;
  guess: DateGuess;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_MS = 86_400_000;
const dayNumber = ({ y, m, d }: YMD) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);

/** "9:00 am" or "14:30", the way the date was written. */
function clock(h: number, mi: number, h24: boolean): string {
  const mm = String(mi).padStart(2, "0");
  if (h24) return `${String(h).padStart(2, "0")}:${mm}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "am" : "pm"}`;
}

/** A day in words next to today: "today", "tomorrow", "Fri" within the week, else "Nov 14" (with the year when it is not this one). */
export function dayWords(day: YMD, today: YMD): string {
  const ahead = dayNumber(day) - dayNumber(today);
  if (ahead === 0) return "today";
  if (ahead === 1) return "tomorrow";
  if (ahead === -1) return "yesterday";
  if (ahead > 1 && ahead < 7) return WEEKDAYS[new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()]!;
  return `${MONTHS[day.m - 1]} ${day.d}${day.y === today.y ? "" : `, ${day.y}`}`;
}

/** The date phrase in the first line, unless the person took its chip off (`dismissed` is the words they kept). */
export function guessLine(line: string, ctx: { now: number; timeZone: string; weekStart: 0 | 1 }, dismissed: string | null): DateGuess | null {
  const guess = guessDate(line, ctx);
  return guess && guess.phrase !== dismissed ? guess : null;
}

/**
 * The chip a date phrase becomes for a collection whose Home date is `field` ("Due today", "Start Fri · 9:00 am"), or null when
 * it cannot be written: a time of day does not fit a date property without one, so the words stay in the title.
 */
export function dateChip(guess: DateGuess | null, field: Extract<Field, { type: "date" }>, ctx: { now: number; timeZone: string }): DateChip | null {
  if (!guess) return null;
  if (guess.time && !field.options.include_time) return null;
  const parts = zonedParts(ctx.now, ctx.timeZone);
  const today: YMD = { y: parts.y, m: parts.m, d: parts.d };
  const value = guess.time
    ? storeParsedDate({ kind: "instant", ms: zonedToInstant({ ...guess.date, h: guess.time.h, mi: guess.time.mi, s: 0, ms: 0 }, ctx.timeZone) }, field.options, ctx.timeZone)
    : storeParsedDate({ kind: "date", ymd: guess.date }, field.options, ctx.timeZone);
  const when = guess.kind === "tonight" ? "tonight" : dayWords(guess.date, today);
  const at = guess.time ? ` · ${clock(guess.time.h, guess.time.mi, guess.timeFormat === "h24")}` : "";
  const name = /^due\b/i.test(field.name) ? "Due" : `${field.name}:`;
  return { label: `${name} ${when}${at}`, value, guess };
}

/** "Saturday, November 7" in the person's zone. */
export function headerDate(now: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(now);
  }
}
