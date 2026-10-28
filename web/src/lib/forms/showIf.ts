/**
 * Show-if conditions of a form: a form entry (a question, a heading, a paragraph) can be shown only while the
 * answers above it meet a condition. The condition is a view `Filter` on the questions above the entry, and is
 * evaluated here for Fill in form, the builder's preview and the public form, and by the server on submit
 * (crates/server/src/store/sharing.rs `show_if_holds`, which runs `ob_core::query::matches`); both read the
 * answers in their stored form (a select answer is a choice id, a checkbox is true, nothing is null) and follow
 * the filter rules of views:
 *   - a condition with an empty operand is ignored, a group left without conditions too;
 *   - negative operators (is not, does not contain, is none of, has none of) are met by an unanswered question,
 *     comparisons are not;
 *   - text is compared without regard to case except for "is" and "is not".
 *
 * Only text, number, rating, checkbox and select questions can be tested (`canTestInShowIf`), and only the
 * questions above the entry, so a form can be evaluated top to bottom: a question that is itself hidden gives
 * no answer to the ones below it.
 */
import type { Condition, Field, Filter, FilterOp } from "@/api/types";
import { isGroup } from "@/lib/cells/filters";
import { kindClassOf, type FieldKindClass } from "@/lib/cells/kinds";

const TESTABLE: ReadonlySet<Field["type"]> = new Set<Field["type"]>([
  "text",
  "rich_text",
  "email",
  "url",
  "phone",
  "number",
  "currency",
  "percent",
  "rating",
  "checkbox",
  "single_select",
  "multiple_select",
]);

/** Whether a show-if can read the answer to this question (mirrors `show_if_source_ok`). */
export function canTestInShowIf(field: Pick<Field, "type">): boolean {
  return TESTABLE.has(field.type);
}

/** How the evaluator sees a field: its type is all it needs. */
export type ShowIfField = Pick<Field, "type">;

/** What to do with a condition on a field the evaluator does not know. */
export type UnknownField =
  /** The field is gone: the condition counts as met. */
  | "skip"
  /** The field exists but is not collected: it is never answered. */
  | "unanswered";

const NEGATIVE: ReadonlySet<FilterOp> = new Set<FilterOp>(["is_not", "does_not_contain", "is_none_of", "has_none_of"]);

function blank(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

function idsOf(v: unknown): string[] {
  if (typeof v === "string") return v === "" ? [] : [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x !== "");
  return [];
}

function equalNumbers(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
}

function numberOperand(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Whether the server drops the condition for its empty operand (it then matches everything). */
function operandIgnored(kind: FieldKindClass, op: FilterOp, value: unknown): boolean {
  if (op === "is_empty" || op === "is_not_empty") return false;
  switch (kind) {
    case "bool":
      return typeof value !== "boolean" && value !== "true" && value !== "false";
    case "number":
      return numberOperand(value) === null;
    case "text":
      return value === null || value === undefined || value === "";
    default:
      return idsOf(value).length === 0;
  }
}

function isEmptyAnswer(kind: FieldKindClass, answer: unknown): boolean {
  if (kind === "bool") return answer !== true;
  return blank(answer);
}

function textMatches(op: FilterOp, answer: unknown, operand: unknown): boolean {
  const hay = typeof answer === "string" ? answer : answer === null || answer === undefined ? "" : String(answer);
  const needle = String(operand);
  const lower = hay.toLowerCase();
  const low = needle.toLowerCase();
  switch (op) {
    case "is":
      return hay === needle;
    case "is_not":
      return hay !== needle;
    case "contains":
      return lower.includes(low);
    case "does_not_contain":
      return !lower.includes(low);
    case "starts_with":
      return lower.startsWith(low);
    case "ends_with":
      return lower.endsWith(low);
    default:
      return false;
  }
}

function numberMatches(op: FilterOp, answer: unknown, operand: unknown): boolean {
  const n = numberOperand(operand) ?? 0;
  if (typeof answer !== "number") return op === "is_not";
  switch (op) {
    case "is":
      return equalNumbers(answer, n);
    case "is_not":
      return !equalNumbers(answer, n);
    case "lt":
      return answer < n && !equalNumbers(answer, n);
    case "lte":
      return answer < n || equalNumbers(answer, n);
    case "gt":
      return answer > n && !equalNumbers(answer, n);
    case "gte":
      return answer > n || equalNumbers(answer, n);
    default:
      return false;
  }
}

function setMatches(op: FilterOp, cell: readonly string[], wanted: readonly string[]): boolean {
  switch (op) {
    case "has_any_of":
      return wanted.some((w) => cell.includes(w));
    case "has_all_of":
      return wanted.every((w) => cell.includes(w));
    case "has_none_of":
      return !wanted.some((w) => cell.includes(w));
    case "is_exactly": {
      const a = new Set(cell);
      const b = new Set(wanted);
      return a.size === b.size && [...a].every((x) => b.has(x));
    }
    default:
      return false;
  }
}

/** One condition against the answer to its question; `field` is unknown for a question the form does not collect. */
function conditionHolds(c: Condition, field: ShowIfField | undefined, answer: unknown): boolean {
  if (!field) {
    // Nothing was answered: the same rules as for an empty cell, whatever the type.
    if (c.op === "is_empty") return true;
    if (c.op === "is_not_empty") return false;
    return NEGATIVE.has(c.op);
  }
  const kind = kindClassOf(field as Field);
  if (c.op === "is_empty") return isEmptyAnswer(kind, answer);
  if (c.op === "is_not_empty") return !isEmptyAnswer(kind, answer);
  switch (kind) {
    case "text":
      return textMatches(c.op, answer, c.value);
    case "number":
      return numberMatches(c.op, answer, c.value);
    case "bool":
      return (answer === true) === (c.value === true || c.value === "true");
    case "select": {
      const cell = idsOf(answer);
      const hit = idsOf(c.value).some((id) => cell.includes(id));
      return c.op === "is_not" || c.op === "is_none_of" ? !hit : hit;
    }
    case "multi_select":
      return setMatches(c.op, idsOf(answer), idsOf(c.value));
    default:
      // Not testable in a form (the server refuses such conditions): never hides anything.
      return true;
  }
}

/** `true`/`false`, or `null` for a condition or group that is ignored. */
function groupHolds(
  filter: Filter,
  fieldOf: (id: string) => ShowIfField | undefined,
  answers: Readonly<Record<string, unknown>>,
  unknown: UnknownField,
): boolean | null {
  const results: boolean[] = [];
  for (const item of filter.items) {
    if (isGroup(item)) {
      const r = groupHolds(item, fieldOf, answers, unknown);
      if (r !== null) results.push(r);
      continue;
    }
    const field = fieldOf(item.field_id);
    if (!field && unknown === "skip") continue;
    const needsOperand = item.op !== "is_empty" && item.op !== "is_not_empty";
    if (field ? operandIgnored(kindClassOf(field as Field), item.op, item.value) : needsOperand && blank(item.value)) continue;
    results.push(conditionHolds(item, field, answers[item.field_id]));
  }
  if (results.length === 0) return null;
  return filter.conjunction === "or" ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Whether an entry with this show-if is shown, given the stored answers of the questions above it that were
 * shown themselves. `fieldOf` knows the questions the form collects; `unknown` says what a condition on any
 * other field means (`"skip"`: it is gone and counts as met; `"unanswered"`: it exists but nobody answers it).
 */
export function showIfHolds(
  showIf: Filter | null | undefined,
  fieldOf: (id: string) => ShowIfField | undefined,
  answers: Readonly<Record<string, unknown>>,
  unknown: UnknownField,
): boolean {
  if (!showIf) return true;
  return groupHolds(showIf, fieldOf, answers, unknown) ?? true;
}

/** One entry of a form for working out what is shown. */
export interface ShowIfEntry {
  /** The question's field id, or the id of a heading or paragraph. */
  id: string;
  showIf: Filter | null | undefined;
  /** The stored answer of a question; absent for a block. Only read while the entry is shown. */
  answer?: () => unknown;
}

/**
 * The ids of the entries shown, going down the form: each entry is tested against the answers of the shown
 * questions above it.
 */
export function shownEntries(entries: readonly ShowIfEntry[], fieldOf: (id: string) => ShowIfField | undefined, unknown: UnknownField): Set<string> {
  const shown = new Set<string>();
  const answers: Record<string, unknown> = {};
  for (const e of entries) {
    if (!showIfHolds(e.showIf, fieldOf, answers, unknown)) continue;
    shown.add(e.id);
    if (e.answer) {
      const a = e.answer();
      if (!blank(a)) answers[e.id] = a;
    }
  }
  return shown;
}

/** The ids of the fields a show-if reads. */
export function showIfFieldIds(showIf: Filter | null | undefined): string[] {
  const out: string[] = [];
  const walk = (f: Filter) => {
    for (const item of f.items) {
      if (isGroup(item)) walk(item);
      else out.push(item.field_id);
    }
  };
  if (showIf) walk(showIf);
  return out;
}

/** A show-if without the conditions that read a field outside `allowed`, and without groups left empty; `null` when nothing is left. */
export function restrictShowIf(showIf: Filter | null | undefined, allowed: ReadonlySet<string>): Filter | null {
  if (!showIf) return null;
  const items: Filter["items"] = [];
  for (const item of showIf.items) {
    if (isGroup(item)) {
      const g = restrictShowIf(item, allowed);
      if (g) items.push(g);
    } else if (allowed.has(item.field_id)) items.push(item);
  }
  return items.length === 0 ? null : { ...showIf, items };
}
