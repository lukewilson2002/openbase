/**
 * The pure rules of a collection's view tabs (COL-2): which views get a tab and in what order, what a tab reads,
 * which tabs fit before the rest go into More, and where a dragged tab lands.
 */
import type { Table, View } from "@/api/types";

/** What a collection's default view reads on its tab: "All" plus the collection's name, lowercased ("All clients"). */
export function defaultTabLabel(tableName: string): string {
  return `All ${tableName.trim().toLowerCase()}`;
}

export interface ViewTab {
  view: View;
  /** What the tab reads. */
  label: string;
}

/**
 * The tabs of a collection: the default view first, then its saved views in the order the server keeps them.
 * A collection from before default views existed has none, and starts with its first saved view.
 */
export function viewTabs(table: Pick<Table, "name" | "views">): ViewTab[] {
  const first = table.views.find((v) => v.is_default);
  const rest = table.views.filter((v) => !v.is_default);
  return [...(first ? [{ view: first, label: defaultTabLabel(table.name) }] : []), ...rest.map((view) => ({ view, label: view.name }))];
}

/**
 * Which of the tabs stay on the strip when it has `available` pixels and the rest go into More: their
 * positions in order. The first tab and the open one always stay (the open one takes the room of the last
 * tabs that fit, so the person never has to open More to see where they are). `moreWidth` is kept free for the
 * More button, but only once something has to go there. Widths of 0 (not measured yet) fit.
 */
export function fitTabs(widths: readonly number[], available: number, moreWidth: number, active: number): number[] {
  const all = widths.map((_, i) => i);
  if (widths.reduce((sum, w) => sum + w, 0) <= available) return all;
  const room = Math.max(0, available - moreWidth);
  const shown: number[] = [];
  let used = 0;
  for (const i of all) {
    if (used + widths[i]! > room && shown.length > 0) break;
    shown.push(i);
    used += widths[i]!;
  }
  if (active >= 0 && !shown.includes(active)) {
    // The open tab takes the place of the last ones that fit, but never the first tab's.
    while (shown.length > 1 && used + widths[active]! > room) used -= widths[shown.pop()!]!;
    shown.push(active);
  }
  return shown;
}

/**
 * The ids of a collection's views in their new order after `moving` was dropped on `over`. A view only moves
 * among the views that are shared or among those that are personal (as the server orders them), so a drop
 * on the other kind, on itself or on the default view changes nothing (`null`).
 */
export function dropOrder(views: readonly View[], moving: string, over: string): string[] | null {
  const from = views.find((v) => v.id === moving);
  const to = views.find((v) => v.id === over);
  if (!from || !to || from.is_default || to.is_default || moving === over || !!from.personal !== !!to.personal) return null;
  const siblings = views.filter((v) => !v.is_default && !!v.personal === !!from.personal).map((v) => v.id);
  const a = siblings.indexOf(moving);
  const b = siblings.indexOf(over);
  if (a < 0 || b < 0) return null;
  const out = [...siblings];
  out.splice(a, 1);
  out.splice(b, 0, moving);
  return out;
}

/** The ids of the views a tab can move among, with the tab's place in them ("Move left" and "Move right" need both). */
export function siblingIds(views: readonly View[], view: View): string[] {
  return views.filter((v) => !v.is_default && !!v.personal === !!view.personal).map((v) => v.id);
}
