/**
 * The list view's outline: `QueryResponse.groups` lists group headers depth-first with the index
 * of each group's first record and its record count. This turns that flat list into a tree,
 * flattens it for rendering with collapsed groups hidden, and works out the field values a new
 * record inside a group should start with.
 */
import type { Field, GroupHeader, LinkRef, TableRecord } from "@/api/types";
import { displayText, type FormatCtx } from "@/lib/cells/format";
import { displayShapeOf, isLinkRef } from "@/lib/cells/kinds";

export interface GroupNode {
  header: GroupHeader;
  /** Unique across the tree: `field:key/field:key/...` from the top group down. */
  path: string;
  children: GroupNode[];
  /** Index of the group's first record in the full ordered result, and how many it holds. */
  start: number;
  count: number;
  /** Header chain from the top group down to this one (inclusive). */
  chain: GroupHeader[];
  /** Place among the groups next to it (1-based) and how many there are, for a screen reader. */
  pos: number;
  size: number;
}

export function buildOutline(groups: readonly GroupHeader[]): GroupNode[] {
  const roots: GroupNode[] = [];
  const stack: GroupNode[] = [];
  for (const header of groups) {
    stack.length = Math.min(header.depth, stack.length);
    const parent = stack[header.depth - 1];
    const node: GroupNode = {
      header,
      path: `${parent ? `${parent.path}/` : ""}${header.field_id}:${header.key}`,
      children: [],
      start: header.start,
      count: header.count,
      chain: [...(parent?.chain ?? []), header],
      pos: 0,
      size: 0,
    };
    (parent ? parent.children : roots).push(node);
    stack[header.depth] = node;
  }
  const number = (list: GroupNode[]) =>
    list.forEach((n, i) => {
      n.pos = i + 1;
      n.size = list.length;
      number(n.children);
    });
  number(roots);
  return roots;
}

export type OutlineRow =
  | { kind: "group"; node: GroupNode; depth: number; collapsed: boolean }
  /** Records `start..start+count` of a group without sub-groups. */
  | { kind: "records"; node: GroupNode; depth: number };

/** Rows to render, skipping everything inside collapsed groups. */
export function flattenOutline(nodes: readonly GroupNode[], collapsed: ReadonlySet<string>): OutlineRow[] {
  const out: OutlineRow[] = [];
  const walk = (list: readonly GroupNode[], depth: number) => {
    for (const node of list) {
      const isCollapsed = collapsed.has(node.path);
      out.push({ kind: "group", node, depth, collapsed: isCollapsed });
      if (isCollapsed) continue;
      if (node.children.length > 0) walk(node.children, depth + 1);
      else out.push({ kind: "records", node, depth: depth + 1 });
    }
  };
  walk(nodes, 0);
  return out;
}

/** Paths of every group, for "collapse all". */
export function allPaths(nodes: readonly GroupNode[]): string[] {
  return nodes.flatMap((n) => [n.path, ...allPaths(n.children)]);
}

/** Field values a record added inside a group starts with: one per group level (blank groups add nothing). */
export function groupDefaults(node: GroupNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const h of node.chain) {
    const v = h.value;
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[h.field_id] = v;
  }
  return out;
}

/** Groups that hold records (those without sub-groups), in order. */
export function leafNodes(nodes: readonly GroupNode[]): GroupNode[] {
  return nodes.flatMap((n) => (n.children.length > 0 ? leafNodes(n.children) : [n]));
}

/** Where a dragged record goes: next to a record (manual order), with the values of the group it lands in. */
export interface DropPlan {
  beforeId?: string;
  afterId?: string;
  /** Field values (view form) that make the record belong to the group it lands in; empty when it stays in its own. */
  values: Record<string, unknown>;
  /** Group headers the record leaves and joins, to keep the outline's counts right until the data is refetched. */
  from: readonly GroupHeader[];
  to: readonly GroupHeader[];
  /** Name of the group it lands in, for the toast ("Moved to Doing"); absent when it stays in its own. */
  groupLabel?: string;
}

export type DropOver = { kind: "row"; id: string } | { kind: "group"; path: string };

/**
 * What dropping record `draggedId` onto a row (before it, or after it when moving down inside its
 * own group) or onto a group heading (the start of the group) does. `ids` are the records in the
 * order they are drawn. Null when nothing would change; "blocked" when the record cannot join that
 * group because `canSet` says its field cannot be written to (a formula or a link).
 */
export function planDrop(ids: readonly string[], roots: readonly GroupNode[], draggedId: string, over: DropOver, canSet: (fieldId: string) => boolean): DropPlan | "blocked" | null {
  const at = ids.indexOf(draggedId);
  if (at < 0) return null;
  const leaves = leafNodes(roots);
  const leafOf = (i: number) => leaves.find((n) => i >= n.start && i < n.start + n.count);
  const source = leafOf(at);
  const from = source?.chain ?? [];

  // The groups whose values the record takes, the groups it ends up counted in, and its place among the records.
  let target: readonly GroupHeader[] = [];
  let landed: readonly GroupHeader[] = [];
  let place: { beforeId?: string; afterId?: string };
  if (over.kind === "row") {
    const to = ids.indexOf(over.id);
    if (to < 0 || to === at) return null;
    const landing = leafOf(to);
    target = landed = landing?.chain ?? [];
    const sameGroup = landing?.path === source?.path;
    place = sameGroup && to > at ? { afterId: over.id } : { beforeId: over.id };
  } else {
    const find = (list: readonly GroupNode[]): GroupNode | undefined => {
      for (const n of list) {
        if (n.path === over.path) return n;
        const inner = find(n.children);
        if (inner) return inner;
      }
      return undefined;
    };
    const node = find(roots);
    const first = node ? ids[node.start] : undefined;
    if (!node || !first || first === draggedId) return null;
    // A heading with sub-groups sets its own level; the record lands in the first sub-group down.
    let leaf = node;
    while (leaf.children.length > 0) leaf = leaf.children[0]!;
    target = node.chain;
    landed = leaf.chain;
    place = { beforeId: first };
  }

  // Every level the record lands in a different group of changes that level's field.
  const values: Record<string, unknown> = {};
  let label: string | undefined;
  for (let depth = 0; depth < target.length; depth++) {
    const joined = target[depth]!;
    if (from[depth] && from[depth]!.key === joined.key && from[depth]!.field_id === joined.field_id) continue;
    if (!canSet(joined.field_id)) return "blocked";
    values[joined.field_id] = joined.value ?? null;
    label = joined.label;
  }
  return { ...place, values, from, to: landed, groupLabel: label };
}

/**
 * The group headers after a record at index `a` of the old order was taken out of the groups `from`
 * and put at index `b` of the new order into the groups `to` (headers are compared by identity).
 * Each header's first record and count follow, so the outline draws the move before the data returns.
 */
export function moveBetweenGroups(groups: readonly GroupHeader[], a: number, b: number, from: readonly GroupHeader[], to: readonly GroupHeader[]): GroupHeader[] {
  return groups.map((h) => {
    const leaves = from.includes(h);
    const joins = to.includes(h);
    // The records after the old place shift up one; then the new place pushes later ones down.
    const afterRemoval = a < h.start ? h.start - 1 : h.start;
    const start = b < afterRemoval || (b === afterRemoval && !joins) ? afterRemoval + 1 : afterRemoval;
    return { ...h, start, count: h.count - (leaves ? 1 : 0) + (joins ? 1 : 0) };
  });
}

/** Where a record at `draggedId` sits before and after `place` is applied to the order `ids`. */
export function placeIndexes(ids: readonly string[], draggedId: string, place: { beforeId?: string; afterId?: string }): { a: number; b: number } | null {
  const a = ids.indexOf(draggedId);
  const rest = ids.filter((id) => id !== draggedId);
  const anchor = rest.indexOf(place.beforeId ?? place.afterId ?? "");
  if (a < 0 || anchor < 0) return null;
  return { a, b: place.beforeId ? anchor : anchor + 1 };
}

/**
 * The records that are on screen: those outside folded groups. `keep` (the record open in the panel)
 * counts even inside a folded group, so Previous and Next from it find their neighbours.
 */
export function visibleIds(ids: readonly string[], roots: readonly GroupNode[], collapsed: ReadonlySet<string>, keep?: string | null): string[] {
  if (collapsed.size === 0) return [...ids];
  const hidden = new Set<number>();
  const walk = (list: readonly GroupNode[]) => {
    for (const n of list) {
      if (collapsed.has(n.path)) {
        for (let i = n.start; i < n.start + n.count; i++) hidden.add(i);
      } else {
        walk(n.children);
      }
    }
  };
  walk(roots);
  return ids.filter((id, i) => !hidden.has(i) || id === keep);
}

// ---------------------------------------------------------------------------------------------
// Sub-items

/** The record a record is the sub-item of: the first record linked in the view's parent field. */
export function parentLinkOf(record: TableRecord, parentFieldId: string | null | undefined): LinkRef | null {
  if (!parentFieldId) return null;
  const v = record.values[parentFieldId];
  return Array.isArray(v) ? (v.find(isLinkRef) ?? null) : null;
}

/** One drawn row of a group: the record, and where it sits in the group's sub-item tree. */
export interface NestedRow {
  record: TableRecord;
  /** Levels below the group's own rows (0 for a row that is not a sub-item). */
  depth: number;
  /** The row above it that it is a sub-item of; null for a top-level row. */
  parentId: string | null;
  /** Rows nested directly under it. */
  children: number;
  /** Place among the rows next to it (1-based) and how many there are. */
  pos: number;
  size: number;
}

/**
 * The records of one group in the order they are drawn: each record followed by its sub-items (the
 * records whose parent field links to it), recursively, siblings in the view's own order. A record
 * whose parent is not among `records` (it is in another group, or is not loaded) is top-level, and
 * so is every record of a loop (A under B under A): nothing is lost. Without a parent field the
 * records come back as they are.
 */
export function nestRows(records: readonly TableRecord[], parentFieldId: string | null | undefined): NestedRow[] {
  if (!parentFieldId) return records.map((record, i) => ({ record, depth: 0, parentId: null, children: 0, pos: i + 1, size: records.length }));
  const present = new Set(records.map((r) => r.id));
  const kids = new Map<string, TableRecord[]>();
  const tops: TableRecord[] = [];
  for (const r of records) {
    const parent = parentLinkOf(r, parentFieldId)?.id;
    if (parent && parent !== r.id && present.has(parent)) kids.set(parent, [...(kids.get(parent) ?? []), r]);
    else tops.push(r);
  }
  const out: NestedRow[] = [];
  const seen = new Set<string>();
  const walk = (list: readonly TableRecord[], depth: number, parentId: string | null) => {
    list.forEach((record, i) => {
      if (seen.has(record.id)) return;
      seen.add(record.id);
      const children = kids.get(record.id) ?? [];
      out.push({ record, depth, parentId, children: children.filter((c) => !seen.has(c.id)).length, pos: i + 1, size: list.length });
      walk(children, depth + 1, record.id);
    });
  };
  walk(tops, 0, null);
  // Records that are only reachable through a loop have no top-level ancestor: they start over as top-level rows.
  const loose = records.filter((r) => !seen.has(r.id));
  for (const r of loose) {
    if (seen.has(r.id)) continue;
    walk([r], 0, null);
  }
  return out;
}

/** The rows left after folding: nothing under a folded row is drawn. */
export function foldRows(rows: readonly NestedRow[], folded: ReadonlySet<string>): NestedRow[] {
  if (folded.size === 0) return [...rows];
  const out: NestedRow[] = [];
  let hideBelow = Infinity;
  for (const row of rows) {
    if (row.depth > hideBelow) continue;
    hideBelow = Infinity;
    out.push(row);
    if (row.children > 0 && folded.has(row.record.id)) hideBelow = row.depth;
  }
  return out;
}

/** The rows above `id` that are folded and hide it, outermost first. */
export function foldedAncestors(rows: readonly NestedRow[], id: string, folded: ReadonlySet<string>): string[] {
  const at = rows.findIndex((r) => r.record.id === id);
  if (at < 0) return [];
  const out: string[] = [];
  let depth = rows[at]!.depth;
  for (let i = at - 1; i >= 0 && depth > 0; i--) {
    if (rows[i]!.depth < depth) {
      depth = rows[i]!.depth;
      if (folded.has(rows[i]!.record.id)) out.unshift(rows[i]!.record.id);
    }
  }
  return out;
}

/** The row above `id` at its own level, whose sub-item indenting it makes it (none for the first of its level). */
export function indentTarget(rows: readonly NestedRow[], id: string): TableRecord | null {
  const at = rows.findIndex((r) => r.record.id === id);
  if (at < 0) return null;
  const depth = rows[at]!.depth;
  for (let i = at - 1; i >= 0; i--) {
    if (rows[i]!.depth === depth) return rows[i]!.record;
    if (rows[i]!.depth < depth) return null;
  }
  return null;
}

/**
 * The value of the parent field that outdenting `id` sets: the parent's own parent, or nothing when
 * the parent is top-level. Null when `id` is not a sub-item (a top-level row with no parent link).
 */
export function outdentValue(rows: readonly NestedRow[], id: string, parentFieldId: string): LinkRef[] | null {
  const row = rows.find((r) => r.record.id === id);
  if (!row) return null;
  if (row.parentId === null) return parentLinkOf(row.record, parentFieldId) ? [] : null;
  const parent = rows.find((r) => r.record.id === row.parentId);
  const grand = parent ? parentLinkOf(parent.record, parentFieldId) : null;
  return grand ? [grand] : [];
}

/** The text of a record's row as a screen reader says it: the title, then the shown values with their field names. */
export function rowLabel(title: string, parts: readonly { field: Field; value: unknown }[], description: string, format: FormatCtx): string {
  const said = parts.map(({ field, value }) => {
    const shape = displayShapeOf(field);
    const text = shape === "checkbox" ? (value === true ? "checked" : "unchecked") : displayText(field, value as TableRecord["values"][string], format);
    return `${field.name}: ${text}`;
  });
  return [title, ...said, description].filter((x) => x !== "").join(", ");
}

// ---------------------------------------------------------------------------------------------
// Groups past the loaded records

/** Records and group headers with the rows fetched for groups past the first records spliced in. */
export interface WithTails {
  records: TableRecord[];
  groups: GroupHeader[];
  /** Rows present per group that holds records (by path; "" without groups). */
  loaded: Map<string, number>;
}

/**
 * The first records of the view are loaded up to a cap, but the group headers cover all of it: a
 * group that starts past the cap (or runs over it) has rows that are fetched when it is opened.
 * This lays `tails` (the fetched rows of such a group, from where the loaded records end) after
 * the loaded records and moves the groups' `start` to match, so everything else can keep reading
 * "the records of a group are `records[start..start+count]`". Without groups, `total` is the
 * count of the one unnamed group "".
 */
export function withTails(records: readonly TableRecord[], groups: readonly GroupHeader[], total: number, tails: ReadonlyMap<string, readonly TableRecord[]>): WithTails {
  const roots = buildOutline(groups);
  const leaves: { path: string; start: number; count: number }[] = groups.length > 0 ? leafNodes(roots) : [{ path: "", start: 0, count: total }];
  const out = [...records];
  // Rows fetched against an older load of the records could repeat one that is loaded now: a record is drawn once.
  const present = new Set(records.map((r) => r.id));
  const loaded = new Map<string, number>();
  const starts = new Map<string, number>();
  for (const leaf of leaves) {
    const have = Math.max(0, Math.min(leaf.count, records.length - leaf.start));
    if (leaf.start + leaf.count <= records.length) {
      starts.set(leaf.path, leaf.start);
      loaded.set(leaf.path, leaf.count);
      continue;
    }
    const tail = (tails.get(leaf.path) ?? []).filter((r) => !present.has(r.id)).slice(0, leaf.count - have);
    for (const r of tail) present.add(r.id);
    // A group that runs over the cap continues straight on from the loaded records; later ones start after the rows loaded so far.
    starts.set(leaf.path, have > 0 ? leaf.start : out.length);
    out.push(...tail);
    loaded.set(leaf.path, have + tail.length);
  }
  if (out.length === records.length) return { records: [...records], groups: [...groups], loaded };
  const moved: GroupHeader[] = [];
  const place = (list: readonly GroupNode[]) => {
    for (const n of list) {
      const start = n.children.length > 0 ? firstStart(n) : (starts.get(n.path) ?? n.start);
      moved.push({ ...n.header, start });
      place(n.children);
    }
  };
  const firstStart = (n: GroupNode): number => (n.children.length > 0 ? firstStart(n.children[0]!) : (starts.get(n.path) ?? n.start));
  place(roots);
  return { records: out, groups: moved, loaded };
}
