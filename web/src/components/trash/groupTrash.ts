import type { TrashItem } from "@/api/types";

/** Kinds shown in a base's trash, in display order. Others (workspace, base) belong elsewhere. */
export const TRASH_KINDS = ["table", "field", "view", "record"] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];

export const TRASH_KIND_LABELS: Record<TrashKind, { plural: string; singular: string }> = {
  table: { plural: "Tables", singular: "table" },
  field: { plural: "Fields", singular: "field" },
  view: { plural: "Views", singular: "view" },
  record: { plural: "Records", singular: "record" },
};

export interface TrashGroup {
  kind: TrashKind;
  items: TrashItem[];
}

function isTrashKind(k: string): k is TrashKind {
  return (TRASH_KINDS as readonly string[]).includes(k);
}

/** Group by kind in display order (empty kinds omitted), newest deletion first within a group. */
export function groupTrash(items: readonly TrashItem[]): TrashGroup[] {
  const groups = new Map<TrashKind, TrashItem[]>();
  for (const item of items) {
    if (!isTrashKind(item.kind)) continue;
    const list = groups.get(item.kind) ?? [];
    list.push(item);
    groups.set(item.kind, list);
  }
  return TRASH_KINDS.filter((k) => groups.has(k)).map((kind) => ({ kind, items: groups.get(kind)!.slice().sort((a, b) => b.deleted_at - a.deleted_at) }));
}

/** What to call an item: records and views can be unnamed. */
export function trashItemName(item: TrashItem): string {
  const name = item.name.trim();
  if (name) return name;
  return item.kind === "record" ? "Untitled record" : `Unnamed ${item.kind}`;
}
