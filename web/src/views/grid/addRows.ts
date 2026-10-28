/**
 * Where a record added from the grid goes. The quiet "Add" row at the end of a group adds into that
 * group, and so does the floating Add button for the group the person is looking at; these are the
 * pure choices behind both, kept apart from the view so they can be tested on their own.
 */
import type { Field, Filter, GroupHeader } from "@/api/types";
import { isWritable, toWire } from "@/lib/cells/wire";
import { prefillFor } from "@/views/common/prefill";
import { isLeafGroup, type RowMap } from "./rowMap";

/** The headers a group sits under, outermost first, ending with the group itself. */
export function groupChain(groups: readonly GroupHeader[], gi: number): GroupHeader[] {
  const own = groups[gi];
  if (!own) return [];
  const chain = [own];
  for (let i = gi - 1, depth = own.depth; i >= 0 && depth > 0; i--) {
    const h = groups[i]!;
    if (h.depth === depth - 1) {
      chain.unshift(h);
      depth = h.depth;
    }
  }
  return chain;
}

/** Field values (raw, as `GroupHeader.value`) a record added into a group starts with: one per level, writable fields only, blank groups add nothing. */
export function groupValues(groups: readonly GroupHeader[], gi: number, fields: readonly Field[]): Record<string, unknown> {
  const byId = new Map(fields.map((f) => [f.id, f] as const));
  const out: Record<string, unknown> = {};
  for (const h of groupChain(groups, gi)) {
    const f = byId.get(h.field_id);
    if (f && isWritable(f)) out[h.field_id] = h.value;
  }
  return out;
}

/**
 * What a record added into group `gi` (-1: none) is created with, as wire values: the values the
 * view's filter pins down, with the group's over them.
 */
export function newRecordValues(fields: readonly Field[], filter: Filter | null | undefined, groups: readonly GroupHeader[], gi: number, currentUserId: string | null = null): Record<string, unknown> {
  const byId = new Map(fields.map((f) => [f.id, f] as const));
  const view = prefillFor(fields, filter, gi >= 0 ? groupValues(groups, gi, fields) : {}, currentUserId);
  return Object.fromEntries(Object.entries(view).map(([id, v]) => [id, byId.has(id) ? toWire(byId.get(id)!, v) : v]));
}

/** The group (header index) a display row belongs to, or -1: a record row or add row names its group, a header its first leaf. */
export function leafGroupOfRow(map: RowMap, groups: readonly GroupHeader[], row: number): number {
  const add = map.addGroupAt(row);
  if (add >= 0) return add;
  const gi = map.groupAt(row);
  if (gi >= 0) {
    let leaf = gi;
    while (!isLeafGroup(groups, leaf)) leaf++;
    return leaf;
  }
  const ri = map.recordIndexAt(row);
  if (ri < 0) return -1;
  return groups.findIndex((g, i) => isLeafGroup(groups, i) && ri >= g.start && ri < g.start + g.count);
}

/**
 * The group the floating Add button adds into: that of the selected cell or row, else that of the
 * row at the top of the visible rows; -1 (the end of the table) with no groups or none in view.
 */
export function floatingAddGroup(map: RowMap, groups: readonly GroupHeader[], selectedRow: number | null, topRow: number | null): number {
  if (groups.length === 0) return -1;
  for (const row of [selectedRow, topRow]) {
    if (row === null || row < 0) continue;
    const gi = leafGroupOfRow(map, groups, row);
    if (gi >= 0) return gi;
  }
  return -1;
}
