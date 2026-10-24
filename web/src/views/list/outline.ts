/**
 * The list view's outline: `QueryResponse.groups` lists group headers depth-first with the index
 * of each group's first record and its record count. This turns that flat list into a tree,
 * flattens it for rendering with collapsed groups hidden, and works out the field values a new
 * record inside a group should start with.
 */
import type { GroupHeader } from "@/api/types";

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
    };
    (parent ? parent.children : roots).push(node);
    stack[header.depth] = node;
  }
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
