/**
 * Column mapping of a CSV import into an existing table.
 *
 * The server keys the mapping by column *name*: the header cell with control characters removed
 * and trimmed, `Column N` when empty, and made unique ("Name", "Name 2", ...); without a header the
 * keys are the zero-based column numbers. `columnKeys` reproduces that, so the mapping the person
 * builds on screen is the one the server reads (`csv_io::parse`, `resolve_mapping`).
 */
import type { Field } from "@/api/types";
import { isComputed } from "@/lib/cells/kinds";

const MAX_NAME_LEN = 255;

/** Mirrors `clean_header_name`: no control characters, trimmed, at most 255 characters. */
export function cleanHeaderName(raw: string, index: number): string {
  // Unicode "Cc" (what Rust's char::is_control tests).
  const cleaned = raw.replace(/\p{Cc}/gu, "").trim();
  if (cleaned === "") return `Column ${index + 1}`;
  return [...cleaned].slice(0, MAX_NAME_LEN).join("");
}

/** Mirrors `schema::uniquify`: `base`, then `base 2`, `base 3`, ... (compared case-insensitively). */
function uniquify(taken: ReadonlySet<string>, base: string): string {
  const fit = (suffix: string) => [...base].slice(0, Math.max(0, MAX_NAME_LEN - [...suffix].length)).join("") + suffix;
  const first = fit("");
  if (!taken.has(first.toLowerCase())) return first;
  for (let n = 2; ; n++) {
    const candidate = fit(` ${n}`);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The name the server gives each column. Without a header every column is "Column N". */
export function columnNames(headerCells: readonly string[], width: number, hasHeader: boolean): string[] {
  const seen = new Set<string>();
  return Array.from({ length: width }, (_, i) => {
    const name = uniquify(seen, cleanHeaderName(hasHeader ? (headerCells[i] ?? "") : "", i));
    seen.add(name.toLowerCase());
    return name;
  });
}

/** The keys of the `mapping` object: the column names, or column numbers when there is no header. */
export function mappingKeys(names: readonly string[], hasHeader: boolean): string[] {
  return hasHeader ? [...names] : names.map((_, i) => String(i));
}

/** Why a field cannot receive imported data, or `null` when it can (mirrors `csv_io::importable`). */
export function importProblem(field: Field): string | null {
  if (isComputed(field)) return "computed";
  if (field.type === "link") return "link fields cannot be imported";
  if (field.type === "user") return "user fields cannot be imported";
  if (field.type === "attachment") return "attachments cannot be imported";
  return null;
}

export const isImportable = (field: Field): boolean => importProblem(field) === null;

/** Target field id per column index, `null` to skip the column. */
export type Assignment = readonly (string | null)[];

/** Match each column to the importable field with the same name (ignoring case); each field once. */
export function autoAssign(names: readonly string[], fields: readonly Field[]): (string | null)[] {
  const used = new Set<string>();
  return names.map((name) => {
    const hit = fields.find((f) => isImportable(f) && !used.has(f.id) && f.name.toLowerCase() === name.toLowerCase());
    if (!hit) return null;
    used.add(hit.id);
    return hit.id;
  });
}

export interface MappingCheck {
  /** Columns that will be imported. */
  mapped: number;
  /** Field ids chosen for more than one column. */
  duplicates: string[];
  ok: boolean;
}

export function checkAssignment(assignment: Assignment): MappingCheck {
  const count = new Map<string, number>();
  for (const id of assignment) if (id) count.set(id, (count.get(id) ?? 0) + 1);
  const duplicates = [...count].filter(([, n]) => n > 1).map(([id]) => id);
  const mapped = assignment.filter(Boolean).length;
  return { mapped, duplicates, ok: mapped > 0 && duplicates.length === 0 };
}

/** The `mapping` form value: every known column, `null` for the skipped ones. */
export function mappingPayload(keys: readonly string[], assignment: Assignment): Record<string, string | null> {
  return Object.fromEntries(keys.map((key, i) => [key, assignment[i] ?? null]));
}

/** "People 2026.csv" -> "People 2026": the name suggested for a new table. */
export function tableNameFromFile(filename: string): string {
  const stem = filename.replace(/\.csv$/i, "").replace(/\p{Cc}/gu, "").trim();
  return stem === "" ? "Imported table" : [...stem].slice(0, MAX_NAME_LEN).join("");
}
