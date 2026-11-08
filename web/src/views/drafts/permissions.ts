/**
 * Who can do what with a draft (decision 4, COL-5). The server enforces the same rules; these decide
 * which buttons the TemporaryChangesBar shows.
 */
import type { View, ViewConfig, ViewType } from "@/api/types";
import { atLeast } from "@/lib/roles";
import { DRAFT_KEYS, LAYOUT_KEYS } from "./classify";
import { touches, type ViewDraft } from "./draft";

/** Who may change the saved config of `view`. */
export function canConfigureView(role: string, view: Pick<View, "personal" | "locked">): boolean {
  if (view.personal) return atLeast(role, "editor");
  return view.locked ? atLeast(role, "creator") : atLeast(role, "editor");
}

export interface DraftActions {
  /** Update view writes the draft to this view. */
  canUpdate: boolean;
  /** What Update view saves: every draft setting, or on the default view the layout settings only. */
  updateKeys: readonly (keyof ViewConfig)[];
  /** Save as view makes a new view of the draft. */
  canSaveAsView: boolean;
  /** Everyone, rather than Only me, as the audience of the new view. */
  canSaveForEveryone: boolean;
}

/**
 * - Reset is for everyone and is not listed here.
 * - Update view: people who may configure this view, when the layout is the view's own. On the default
 *   view, which sets the layout of every record, editors and up, and only for its layout settings; its
 *   filter, sorts, groups and colors can only become a new view (as the server enforces).
 * - Save as view: editors and up. Only me makes a personal view; Everyone needs the creator role.
 */
export function draftActions(role: string, view: Pick<View, "personal" | "locked" | "is_default" | "type">, draft: ViewDraft | null): DraftActions {
  const sameLayout = !draft?.layout || draft.layout === view.type;
  const updateKeys = view.is_default ? LAYOUT_KEYS : DRAFT_KEYS;
  const canUpdate = !!draft && sameLayout && canConfigureView(role, view) && touches(draft, updateKeys);
  return { canUpdate, updateKeys, canSaveAsView: !!draft && atLeast(role, "editor"), canSaveForEveryone: atLeast(role, "creator") };
}

/** The layout a draft shows. */
export function draftLayout(view: Pick<View, "type">, draft: ViewDraft | null): ViewType {
  return draft?.layout ?? view.type;
}
