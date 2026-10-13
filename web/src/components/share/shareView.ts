/**
 * The parts of "Share view" the app shell needs without loading the dialog itself (which is a
 * separate chunk, see LazyShareViewDialog.tsx): who may share, and what kind of link a view gets.
 */
import type { ShareKind, View } from "@/api/types";
import { atLeast } from "@/lib/roles";

/** At most this many links per view (`MAX_SHARES_PER_VIEW` on the server). */
export const MAX_SHARES_PER_VIEW = 20;

/** Whether the person may manage share links of the view (the server enforces it as well). */
export function canShareView(role: string, view: Pick<View, "personal">): boolean {
  return atLeast(role, "creator") && !view.personal;
}

/** The kind of link a view gets: form views are shared as forms, everything else read-only. */
export function shareKindOf(view: Pick<View, "type">): ShareKind {
  return view.type === "form" ? "form" : "view";
}
