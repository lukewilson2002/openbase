/**
 * Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes the last record change of a view. Left
 * alone while typing in a field (the field's own undo), inside a dialog or menu, and when the person
 * cannot edit.
 */
import { useEffect, useRef } from "react";
import type { RecordHistory } from "./useRecordWrites";

function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}

export function useUndoShortcuts(history: RecordHistory, enabled: boolean): void {
  const ref = useRef(history);
  ref.current = history;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      const redo = (key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey);
      const undo = key === "z" && !e.shiftKey;
      if (!undo && !redo) return;
      if (typingIn(e.target)) return;
      if (e.target instanceof Element && e.target.closest("[role=dialog],[role=alertdialog],[role=menu],[role=listbox]")) return;
      const h = ref.current;
      if (redo ? !h.canRedo : !h.canUndo) return;
      e.preventDefault();
      void (redo ? h.redo() : h.undo());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
