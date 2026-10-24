/**
 * Pure kanban logic: which fields can stack, bucketing records into stacks (in choice order or
 * `stack_order`, plus "Uncategorized"), the values a drop writes, and the plan for a drag.
 *
 * A stack is identified by a string key, matching `KanbanConfig.stack_order`: the choice id
 * (single select), the user id (single user), "true"/"false" (checkbox) or "" (Uncategorized).
 */
import type { Collaborator, Field, TableRecord } from "@/api/types";
import { stringItems } from "@/lib/cells/kinds";

export const UNCATEGORIZED = "";

export type StackKind = "select" | "user" | "checkbox";

/** Fields a kanban can stack by: single select, single user, checkbox. */
export function stackKind(field: Field | undefined): StackKind | null {
  if (!field) return null;
  if (field.type === "single_select") return "select";
  if (field.type === "user" && !field.options.multiple) return "user";
  if (field.type === "checkbox") return "checkbox";
  return null;
}

export const isStackField = (field: Field): boolean => stackKind(field) !== null;

export interface Stack {
  key: string;
  label: string;
  /** Palette colour of the select choice. */
  color?: string;
  uncategorized: boolean;
  records: TableRecord[];
  /** Left off the board by the view's `hidden_stacks` (only `buildAllStacks` returns these). */
  hidden?: boolean;
}

/** The stack a record belongs to. Unknown choices and missing values are Uncategorized. */
export function recordStackKey(field: Field, record: TableRecord): string {
  const v = record.values[field.id];
  switch (stackKind(field)) {
    case "select": {
      const id = stringItems(v)[0];
      return id && field.type === "single_select" && field.options.choices.some((c) => c.id === id) ? id : UNCATEGORIZED;
    }
    case "user":
      return stringItems(v)[0] ?? UNCATEGORIZED;
    case "checkbox":
      return v === true ? "true" : "false";
    default:
      return UNCATEGORIZED;
  }
}

/** Cell value (view form) that puts a record in a stack; null clears the field. */
export function stackValue(field: Field, key: string): unknown {
  switch (stackKind(field)) {
    case "select":
      return key === UNCATEGORIZED ? null : key;
    case "user":
      return key === UNCATEGORIZED ? null : [key];
    case "checkbox":
      return key === "true" ? true : null;
    default:
      return null;
  }
}

export interface BuildStacksOptions {
  stackOrder: readonly string[];
  hideEmpty: boolean;
  people: readonly Pick<Collaborator, "id" | "name">[];
  /** Stack keys the view leaves off the board. */
  hiddenStacks?: readonly string[];
  /** Person stacks: one for every collaborator. Off: only for people who hold cards. */
  showAllPeople?: boolean;
  /** The collaborators have not loaded yet: people missing from `people` are not strangers yet. */
  peopleLoading?: boolean;
}

/** Label of a stack for someone who is not (or not yet known as) a collaborator: never their id. */
function strangerLabel(opts: BuildStacksOptions, nth: number): string {
  if (opts.peopleLoading) return "Loading people…";
  return nth === 0 ? "Former member" : `Former member ${nth + 1}`;
}

/**
 * Every stack for a stack field, in display order, holding the records in their given order. The ones the
 * view hides are flagged `hidden` rather than dropped, so the board can offer to bring them back.
 */
export function buildAllStacks(field: Field, records: readonly TableRecord[], opts: BuildStacksOptions): Stack[] {
  const kind = stackKind(field);
  if (!kind) return [];
  const buckets = new Map<string, TableRecord[]>();
  for (const r of records) {
    const key = recordStackKey(field, r);
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }

  const meta = new Map<string, { label: string; color?: string }>();
  const natural: string[] = [];
  const add = (key: string, label: string, color?: string) => {
    meta.set(key, { label, color });
    natural.push(key);
  };
  if (kind === "select" && field.type === "single_select") {
    add(UNCATEGORIZED, "Uncategorized");
    for (const c of field.options.choices) add(c.id, c.name, c.color);
  } else if (kind === "user") {
    add(UNCATEGORIZED, "Uncategorized");
    // Collaborators with no cards only get a stack when asked for: a large base would fill the board with them.
    for (const p of opts.people) if (opts.showAllPeople || buckets.has(p.id)) add(p.id, p.name);
    // Users who hold cards but are no longer collaborators still need a stack.
    const strangers = [...buckets.keys()].filter((key) => key !== UNCATEGORIZED && !meta.has(key)).sort();
    strangers.forEach((key, i) => add(key, strangerLabel(opts, i)));
  } else {
    add("false", "Unchecked");
    add("true", "Checked", "green");
  }

  const inOrder = opts.stackOrder.filter((k, i, a) => meta.has(k) && a.indexOf(k) === i);
  const ordered = [...inOrder, ...natural.filter((k) => !inOrder.includes(k))];
  const hidden = new Set(opts.hiddenStacks ?? []);

  const stacks: Stack[] = ordered.map((key) => ({
    key,
    label: meta.get(key)!.label,
    color: meta.get(key)!.color,
    uncategorized: key === UNCATEGORIZED,
    records: buckets.get(key) ?? [],
    ...(hidden.has(key) ? { hidden: true } : {}),
  }));
  // An empty Uncategorized stack is not a value anyone chose, only a column of nothing in front of
  // the real stacks; it shows up again as soon as a card has no value.
  return stacks.filter((s) => s.records.length > 0 || (!opts.hideEmpty && !s.uncategorized));
}

/** The stacks the board draws: `buildAllStacks` without the hidden ones. */
export function buildStacks(field: Field, records: readonly TableRecord[], opts: BuildStacksOptions): Stack[] {
  return buildAllStacks(field, records, opts).filter((s) => !s.hidden);
}

/**
 * The empty drop target offered while a card is dragged when no "Uncategorized" stack is on the board
 * (it is empty, or hidden), so a drop can still clear the card's value. Checkboxes always have both stacks.
 */
export function clearStack(field: Field, shown: readonly Pick<Stack, "key">[]): Stack | null {
  const kind = stackKind(field);
  if (kind !== "select" && kind !== "user") return null;
  if (shown.some((s) => s.key === UNCATEGORIZED)) return null;
  return { key: UNCATEGORIZED, label: "Uncategorized", uncategorized: true, records: [] };
}

/** `stack_order` after moving a stack one place left or right among the shown stacks. */
export function moveStackKey(shownKeys: readonly string[], key: string, dir: -1 | 1): string[] {
  const i = shownKeys.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= shownKeys.length) return [...shownKeys];
  const next = [...shownKeys];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/**
 * `stack_order` after the shown stacks were put in a new order. Hidden stacks keep their place among
 * `allKeys` (the order before), so they come back where they were.
 */
export function applyShownOrder(allKeys: readonly string[], shownBefore: readonly string[], shownAfter: readonly string[]): string[] {
  const shown = new Set(shownBefore);
  const queue = [...shownAfter];
  return allKeys.map((k) => (shown.has(k) ? (queue.shift() ?? k) : k));
}

export interface DropPlan {
  recordId: string;
  fromKey: string;
  toKey: string;
  /** The stack field must be written (the card changed stacks). */
  changeValue: boolean;
  /** Manual-order move relative to a neighbour in the target stack; null = leave order alone. */
  anchor: { beforeId: string } | { afterId: string } | null;
}

/**
 * Decide what a drop writes. `fromIds` is the origin stack's card order before the drag and
 * `targetIds` the target stack's order after it (including the dragged card).
 *
 * Reordering needs a manual order: with sorts the server decides the order, so a drop inside
 * the same stack is a no-op and a drop into another stack only changes the stack field.
 */
export function planDrop(args: { recordId: string; fromKey: string; toKey: string; fromIds: readonly string[]; targetIds: readonly string[]; hasSorts: boolean }): DropPlan | null {
  const { recordId, fromKey, toKey, fromIds, targetIds, hasSorts } = args;
  const at = targetIds.indexOf(recordId);
  if (at < 0) return null;
  const changeValue = fromKey !== toKey;
  if (!changeValue) {
    if (hasSorts) return null;
    if (fromIds.indexOf(recordId) === at) return null;
  }
  let anchor: DropPlan["anchor"] = null;
  if (!hasSorts) {
    const next = targetIds[at + 1];
    const prev = targetIds[at - 1];
    if (next) anchor = { beforeId: next };
    else if (prev) anchor = { afterId: prev };
  }
  return { recordId, fromKey, toKey, changeValue, anchor };
}
