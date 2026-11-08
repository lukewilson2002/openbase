import type { CSSProperties } from "react";
import type { Editor } from "@tiptap/core";

/**
 * Where a list that belongs to the text at `pos` sits inside `box` (the editor's positioned container): under the
 * character, or above it near the bottom of the window, kept within the box's width. Used by the mention list and
 * the page's block menu.
 */
export function anchorStyle(editor: Editor, box: HTMLElement, pos: number, width: number): CSSProperties {
  const rect = box.getBoundingClientRect();
  let at = { left: rect.left + 8, top: rect.top, bottom: rect.top + 24 };
  try {
    at = editor.view.coordsAtPos(pos);
  } catch {
    // No layout to measure (a document without one): the list goes at the top left.
  }
  const left = Math.max(4, Math.min(at.left - rect.left, rect.width - width));
  const below = window.innerHeight - at.bottom > 240;
  return below ? { left, top: at.bottom - rect.top + box.scrollTop + 4 } : { left, bottom: rect.bottom - at.top - box.scrollTop + 4 };
}
