/**
 * Prefilling a public form from its address, for links made for one customer, ticket or order:
 *
 *   /form/shr_...?prefill_Customer=Acme&prefill_Priority=High&hide_Customer=true
 *
 *   - `prefill_<Field>=<value>` starts the field with that value;
 *   - `hide_<Field>=true` takes the field off the page (its prefilled or default value is still sent). A required
 *     field that would be left empty is never hidden.
 *
 * `<Field>` is the question as the form labels it (case does not matter; spaces are written %20 or +) or its field id.
 * Values: text as it is; numbers as digits; dates as 2026-03-01 (with a time: 2026-03-01T14:30); a single select by
 * the option's name; a multiple select by option names, separated by commas or repeated; a checkbox as true or false;
 * a rating as a number. A value that does not fit the field is ignored. Files cannot be prefilled.
 * Headings and paragraphs are not affected.
 */
import type { PublicFormField } from "@/api/types";
import { choicesOfInput, controlKindOf, ratingMaxOfInput, type FormInput } from "./publicValues";

export interface Prefill {
  /** Starting inputs by field id. */
  values: Record<string, FormInput>;
  /** Ids of the fields to leave off the page. */
  hidden: Set<string>;
}

const TRUE = new Set(["true", "1", "yes", "on", "checked"]);
const FALSE = new Set(["false", "0", "no", "off", "unchecked"]);

/** The field a parameter names: by id, else by label. */
function findField(fields: readonly PublicFormField[], name: string): PublicFormField | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return undefined;
  const questions = fields.filter((f) => !f.block);
  return questions.find((f) => f.id.toLowerCase() === wanted) ?? questions.find((f) => f.label.trim().toLowerCase() === wanted);
}

function choiceId(f: PublicFormField, text: string): string | null {
  const wanted = text.trim().toLowerCase();
  if (wanted === "") return null;
  const choices = choicesOfInput(f);
  return (choices.find((c) => c.id.toLowerCase() === wanted) ?? choices.find((c) => c.name.trim().toLowerCase() === wanted))?.id ?? null;
}

/** The input a text from the address stands for, or undefined when it does not fit the field. */
function inputFor(f: PublicFormField, texts: readonly string[]): FormInput | undefined {
  const text = texts[0] ?? "";
  switch (controlKindOf(f)) {
    case "text":
    case "textarea":
    case "email":
    case "url":
    case "tel":
      return text;
    case "number":
      return text.trim() !== "" && Number.isFinite(Number(text)) ? text.trim() : undefined;
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(text.trim()) ? text.trim() : undefined;
    case "datetime":
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text.trim()) ? text.trim() : undefined;
    case "select":
      return choiceId(f, text) ?? undefined;
    case "multiselect": {
      const ids = texts
        .flatMap((t) => t.split(","))
        .map((t) => choiceId(f, t))
        .filter((id): id is string => id !== null);
      return ids.length > 0 ? [...new Set(ids)] : undefined;
    }
    case "checkbox": {
      const t = text.trim().toLowerCase();
      return TRUE.has(t) ? true : FALSE.has(t) ? false : undefined;
    }
    case "rating": {
      const n = Number(text);
      return Number.isInteger(n) && n >= 1 && n <= ratingMaxOfInput(f) ? n : undefined;
    }
    default:
      return undefined;
  }
}

/** What the address (`location.search`) prefills and hides. */
export function readPrefill(fields: readonly PublicFormField[], search: string): Prefill {
  const out: Prefill = { values: {}, hidden: new Set() };
  const params = new URLSearchParams(search);
  const hide = new Set<string>();
  for (const key of new Set(params.keys())) {
    const lower = key.toLowerCase();
    if (lower.startsWith("prefill_")) {
      const f = findField(fields, key.slice("prefill_".length));
      const input = f ? inputFor(f, params.getAll(key)) : undefined;
      if (f && input !== undefined) out.values[f.id] = input;
    } else if (lower.startsWith("hide_")) {
      const f = findField(fields, key.slice("hide_".length));
      const v = (params.get(key) ?? "").trim().toLowerCase();
      if (f && (v === "" || TRUE.has(v))) hide.add(f.id);
    }
  }
  for (const id of hide) {
    const f = fields.find((x) => x.id === id);
    // A hidden required question with nothing in it could not be submitted.
    const filled = id in out.values || (f?.default !== null && f?.default !== undefined && f.default !== "");
    if (f && (!f.required || filled)) out.hidden.add(id);
  }
  return out;
}
