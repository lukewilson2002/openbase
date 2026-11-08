/**
 * The rules behind "Add property" on the record page (REC-4, FLD-1): which type a typed value gets, what the
 * chip says about it, and how the value becomes the cell. `guessType` returns a type and its options but not a
 * cell value; a rating written as stars and a checkbox written as a check mark are turned into cells here.
 *
 * Everything is a pure function of the text (the date reads the clock it is given), so the same input gives the
 * same result (decision 7).
 */
import type { Field, FieldKind, FieldType } from "@/api/types";
import { FIELD_TYPE_LABELS } from "@/components/ui/field-type-icon";
import { defaultKind, type KindContext } from "@/components/fields/fieldKinds";
import { nextChoiceColor } from "@/components/fields/choices";
import { parseText, type ParseCtx, type ParseResult } from "@/lib/cells/parse";
import { splitList } from "@/lib/cells/text";
import { guessDate } from "@/lib/dateGuess";
import { guessType } from "@/lib/guessType";

/** Types that are made in the property dialog, not from a box: they need a target or a formula that no guess can give. */
const NEEDS_SETUP: ReadonlySet<FieldType> = new Set(["link", "formula", "lookup", "rollup", "count", "button"]);

export function needsSetup(type: FieldType): boolean {
  return NEEDS_SETUP.has(type);
}

const NO_TYPED_VALUE: Partial<Record<FieldType, string>> = {
  link: "Link records once the property exists",
  attachment: "Add files once the property exists",
  formula: "Worked out from the formula",
  lookup: "Worked out from the linked records",
  rollup: "Worked out from the linked records",
  count: "Worked out from the linked records",
  button: "A button has no value",
  created_time: "Filled in by OpenBase",
  last_modified_time: "Filled in by OpenBase",
  created_by: "Filled in by OpenBase",
  last_modified_by: "Filled in by OpenBase",
  autonumber: "Filled in by OpenBase",
};

/** Why a value cannot be typed for a property of this type, or null when it can. */
export function whyNoValue(type: FieldType): string | null {
  return NO_TYPED_VALUE[type] ?? null;
}

const decimalsOf = (text: string): number => Math.min(8, /\.(\d+)/.exec(text)?.[1]?.length ?? 0);

/** Options for a type chosen by hand, shaped by the value typed so far so that what was typed survives. */
function chosenKind(type: FieldType, text: string, ctx: KindContext): FieldKind {
  const kind = defaultKind(type, ctx);
  switch (kind.type) {
    case "number":
    case "percent":
      return { ...kind, options: { ...kind.options, precision: decimalsOf(text) } };
    case "currency":
      return { ...kind, options: { ...kind.options, precision: Math.max(2, decimalsOf(text)) } };
    case "single_select":
    case "multiple_select": {
      // The typed names become the first choices, so the value has something to point at.
      const names = kind.type === "multiple_select" ? splitList(text) : text.trim() ? [text.trim()] : [];
      const choices: { id: string; name: string; color: string }[] = [];
      for (const name of names) if (!choices.some((c) => c.name.toLowerCase() === name.toLowerCase())) choices.push({ id: "", name, color: nextChoiceColor(choices) });
      return { type: kind.type, options: { choices } };
    }
    default:
      return kind;
  }
}

export interface PropertyPlan {
  kind: FieldKind;
  /** Whether the type came from the value (the guess) rather than from a choice. */
  guessed: boolean;
}

/** The type and options the new property gets: the person's choice if they made one, else what the value looks like. */
export function planProperty(text: string, chosen: FieldType | null, ctx: KindContext): PropertyPlan {
  const guess = guessType(text);
  if (chosen === null) return { kind: { type: guess.type, options: guess.options } as FieldKind, guessed: true };
  // Choosing what the guess is already keeps the options it worked out (the date format, the symbol).
  if (chosen === guess.type) return { kind: { type: guess.type, options: guess.options } as FieldKind, guessed: false };
  return { kind: chosenKind(chosen, text, ctx), guessed: false };
}

const PREVIEW = 24;

/** The chip beside the value: "Date · Guessed from “Nov 14”", or what was chosen. */
export function chipText(plan: PropertyPlan, text: string): string {
  const label = FIELD_TYPE_LABELS[plan.kind.type];
  if (!plan.guessed) return `${label} · You chose this type`;
  const v = text.trim();
  if (!v) return label;
  return `${label} · Guessed from “${v.length > PREVIEW ? `${v.slice(0, PREVIEW - 1)}…` : v}”`;
}

export interface ValueCtx extends ParseCtx {
  /** The moment the text is read, for dates like "Friday". */
  now: number;
  weekStart: 0 | 1;
}

const CROSSES = /^[✗✘×]$/u;
const HOLLOW_STARS = /^[☆ ]+$/u;

/**
 * The cell for the text typed beside a new property, once the property exists (`field`). Blank gives null (no
 * value). A date reads like capture does ("Nov 14", "Friday 9am"), a check mark or yes ticks a checkbox and a
 * cross or no leaves it clear, stars give a rating; everything else is parsed as it is when pasted into a cell.
 */
export function valueFor(field: Field, text: string, ctx: ValueCtx): ParseResult {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  switch (field.type) {
    case "date": {
      const g = guessDate(t, { now: ctx.now, timeZone: ctx.timeZone, weekStart: ctx.weekStart });
      if (g && g.phrase === t && g.kind !== "time" && field.options.include_time === (g.time !== null)) return { ok: true, value: g.value };
      break;
    }
    case "checkbox":
      if (CROSSES.test(t)) return { ok: true, value: null };
      break;
    case "rating":
      if (HOLLOW_STARS.test(t)) return { ok: true, value: null };
      break;
    default:
      break;
  }
  return parseText(field, t, ctx);
}

/**
 * A stand-in for the property, to check a value against its type before the property is made: the type and
 * options, with a name and ids that mean nothing.
 */
export function probeField(kind: FieldKind): Field {
  return { id: "fld_probe", table_id: "tbl_probe", name: "probe", description: null, ...kind } as Field;
}
