/** Helpers for select-field choices shared by the field dialog and the select editors. */
import { schemaApi } from "@/api/records";
import type { Field, SelectChoice } from "@/api/types";
import { COLORS } from "@/lib/colors";

/** The palette colour a new choice gets: the first colour not yet used, cycling after 20. */
export function nextChoiceColor(choices: readonly SelectChoice[]): string {
  const used = new Set(choices.map((c) => c.color));
  return COLORS.find((c) => !used.has(c)) ?? COLORS[choices.length % COLORS.length]!;
}

export type SelectField = Extract<Field, { type: "single_select" | "multiple_select" }>;

export function isSelectField(f: Field): f is SelectField {
  return f.type === "single_select" || f.type === "multiple_select";
}

/**
 * Add a choice to a select field (creators and owners only; the server enforces it) and return
 * the created choice. The server assigns the id.
 */
export async function createChoice(field: SelectField, name: string): Promise<SelectChoice> {
  const trimmed = name.trim();
  const existing = field.options.choices.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing;
  const choices: SelectChoice[] = [...field.options.choices, { id: "", name: trimmed, color: nextChoiceColor(field.options.choices) }];
  const updated = await schemaApi.updateField(field.id, { type: field.type, options: { choices } });
  const list = updated.type === "single_select" || updated.type === "multiple_select" ? updated.options.choices : [];
  const created = list.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
  if (!created) throw new Error("The option could not be created");
  return created;
}
