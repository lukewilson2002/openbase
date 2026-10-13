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
