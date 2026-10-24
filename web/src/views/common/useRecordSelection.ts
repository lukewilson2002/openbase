/**
 * Selecting several records of a card or row view (kanban, gallery, list, timeline) to act on them
 * together. `ids` are the records in the order the view draws them (that is what Shift-click ranges
 * run over); a selection forgets records that leave the view (deleted, filtered out).
 *
 *   const sel = useRecordSelection(orderedIds);
 *   <Card onClick={(e) => { if (!sel.handleClick(id, e)) open(id); }} data-selected={sel.has(id)} />
 *   <div onKeyDown={(e) => sel.handleKeyDown(e, { onDelete: () => actions.requestDelete([...sel.ids], sel.clear) })}>
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";

export interface RecordSelection {
  /** The selected ids, in the order the view draws them. */
  ids: readonly string[];
  count: number;
  has(id: string): boolean;
  /** Add or remove one record (the tick box of a card). */
  toggle(id: string): void;
  /** Select exactly these. */
  set(ids: readonly string[]): void;
  selectAll(): void;
  clear(): void;
  /**
   * A click on a record. Ctrl/Cmd-click toggles it, Shift-click selects the range from the last one
   * clicked, and once something is selected a plain click toggles too. Returns true when the click was
   * a selection (the view does nothing more), false for a plain click on nothing selected: open the record.
   */
  handleClick(id: string, e: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey" | "preventDefault">): boolean;
  /**
   * Keys for the view's container (or a focused card): Escape clears; Ctrl/Cmd+A selects all (not
   * while typing in a field); Delete and Backspace call `onDelete` when something is selected.
   * Returns true when it used the key.
   */
  handleKeyDown(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "target" | "preventDefault">, opts?: { onDelete?: () => void }): boolean;
}

function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}

export function useRecordSelection(orderedIds: readonly string[]): RecordSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  // Records that left the view leave the selection.
  useEffect(() => {
    setSelected((cur) => {
      if (cur.size === 0) return cur;
      const here = new Set(orderedIds);
      const next = new Set([...cur].filter((id) => here.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [orderedIds]);

  const ids = useMemo(() => orderedIds.filter((id) => selected.has(id)), [orderedIds, selected]);
  const has = useCallback((id: string) => selected.has(id), [selected]);

  const toggle = useCallback((id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
    setAnchor(id);
  }, []);
  const set = useCallback((list: readonly string[]) => setSelected(new Set(list)), []);
  const selectAll = useCallback(() => setSelected(new Set(orderedIds)), [orderedIds]);
  const clear = useCallback(() => {
    setSelected((cur) => (cur.size === 0 ? cur : new Set()));
    setAnchor(null);
  }, []);

  const handleClick = useCallback<RecordSelection["handleClick"]>(
    (id, e) => {
      if (e.shiftKey && anchor && anchor !== id) {
        const a = orderedIds.indexOf(anchor);
        const b = orderedIds.indexOf(id);
        if (a >= 0 && b >= 0) {
          e.preventDefault();
          const range = orderedIds.slice(Math.min(a, b), Math.max(a, b) + 1);
          // Ctrl/Cmd keeps what was selected before; a plain Shift-click replaces it.
          setSelected((cur) => new Set(e.ctrlKey || e.metaKey ? [...cur, ...range] : range));
          return true;
        }
      }
      if (e.shiftKey || e.ctrlKey || e.metaKey || selected.size > 0) {
        e.preventDefault();
        toggle(id);
        return true;
      }
      return false;
    },
    [anchor, orderedIds, selected, toggle],
  );

  const handleKeyDown = useCallback<RecordSelection["handleKeyDown"]>(
    (e, opts) => {
      if (typingIn(e.target)) return false;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape" && selected.size > 0) {
        clear();
        return true;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
        return true;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !mod && selected.size > 0 && opts?.onDelete) {
        e.preventDefault();
        opts.onDelete();
        return true;
      }
      return false;
    },
    [selected, clear, selectAll],
  );

  return useMemo(
    () => ({ ids, count: ids.length, has, toggle, set, selectAll, clear, handleClick, handleKeyDown }),
    [ids, has, toggle, set, selectAll, clear, handleClick, handleKeyDown],
  );
}
