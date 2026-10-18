/**
 * One field's value in the expanded record: shown rendered (the grid's read renderer, `CellValue`)
 * until it is clicked, then replaced by the field's form editor, focused and ready.
 *
 * - Where the field is editable the value area is a button (`role="button"`, "Edit Notes", the value
 *   as its description): hovering it tints it, a click, Enter or Space starts the edit. Clicks on links,
 *   buttons, players and files inside the rendered value do their own thing and start nothing.
 * - Pop-over editors (selects, links, people, files) open their pop-over at once (see session.ts).
 * - A checkbox and a rating are edited where they are: they are the control, not a picture of one.
 * - The edit ends when the editor commits (Enter, a pick, Done), is cancelled (Escape), or when focus
 *   leaves the field. Pop-overs, menus and the full-screen dialog of an editor are part of the field,
 *   though they render in portals (React's focus events tell). Long text saves while it is typed, so only leaving ends its edit.
 * - What was just saved stays on screen until the record catches up, and what could not be saved stays
 *   too (with the field's error under it), so the typed text is not lost.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { Field } from "@/api/types";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { displayShapeOf } from "@/lib/cells/kinds";
import { CellValue } from "./CellValue";
import { FieldEditor } from "./editors/FieldEditor";
import { EditSessionProvider, type EditSession } from "./editors/session";
import type { EditValue } from "./editors/env";

/** Inside a rendered value, what answers a click itself. */
const INTERACTIVE = "a[href], button, input, select, textarea, summary, video, audio, iframe, [role=button], [role=checkbox], [contenteditable=true]";

/** Whether a mouse button, finger or pen is down (a field must not shrink under a press that is on its way to a click). */
let pressed = false;
const press = (down: boolean) => () => {
  pressed = down;
};
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", press(true), true);
  for (const type of ["pointerup", "pointercancel", "dragend"]) document.addEventListener(type, press(false), true);
}

/** Runs `fn` once the current press, if any, is over (and the click it makes has been handled). */
function afterPress(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    timer = setTimeout(fn, 0);
  };
  if (!pressed) {
    run();
    return () => clearTimeout(timer);
  }
  document.addEventListener("pointerup", run, { capture: true, once: true });
  document.addEventListener("pointercancel", run, { capture: true, once: true });
  return () => {
    clearTimeout(timer);
    document.removeEventListener("pointerup", run, true);
    document.removeEventListener("pointercancel", run, true);
  };
}

/** Whether the field has nothing to show (a checked box or a rating of 0 are values; a text of "" is not). */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || value === false || (Array.isArray(value) && value.length === 0);
}

/** Fields whose editor is a pop-over off a button: the pointer says "pick" rather than "type". */
const PICKERS = new Set(["select", "multi_select", "link", "user", "attachment"]);

export interface EditableValueProps {
  field: Field;
  /** What the record holds. */
  value: unknown;
  /** A value that was not saved (and the reason is shown by the host): it stays instead of the record's. */
  failed?: { value: unknown };
  labelId: string;
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  /** Changes when the editor has to be built again (see FieldRow). */
  editorKey: string;
  /** The edit has started already (a record just added). */
  startEditing?: boolean;
  onChange?: (edit: EditValue) => void;
  /** Saves the edit and answers the value it saved, if it did. */
  onCommit: (edit: EditValue) => { value: unknown } | null | undefined;
}

export function EditableValue({ field, value, failed, labelId, format, emails, editorKey, startEditing = false, onChange, onCommit }: EditableValueProps) {
  const shape = displayShapeOf(field);
  const direct = shape === "checkbox" || shape === "rating";
  const long = field.type === "long_text";
  const [editing, setEditing] = useState(startEditing && !direct);
  const viewRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const describedBy = useId();

  // What was saved last shows until the record has the value (a moment after the edit is over).
  const json = JSON.stringify(value);
  const [held, setHeld] = useState<{ value: unknown } | null>(null);
  const [heldFor, setHeldFor] = useState(json);
  if (heldFor !== json) {
    setHeldFor(json);
    setHeld(null);
  }
  const shown = failed ? failed.value : held ? held.value : value;

  /** Ends the edit; with `focus` the value area takes the focus (the editor it replaces had it), unless a press is on its way elsewhere. */
  const stop = (focus: boolean) => {
    restoreFocus.current = focus && !pressed;
    setEditing(false);
  };
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useLayoutEffect(() => {
    if (editing || !restoreFocus.current) return;
    restoreFocus.current = false;
    viewRef.current?.focus();
  }, [editing]);

  const session = useMemo<EditSession>(() => ({ openOnMount: true, popupClosed: () => stopRef.current(true) }), []);

  // Focus leaving the field ends the edit. React's focus events reach the field's wrapper from the layers its
  // editor opens in portals (pop-overs, menus, the full-screen dialog) as they do from its own elements, so
  // focus moving into one is not leaving; a pop-over of another field is not ours and is leaving. The check
  // waits a moment, and for a press to be over: focus passes through the body while a pop-over opens or
  // closes, and a field that shrinks under a click sends the click to whatever slid into its place.
  // A value that does not parse stays open to be fixed.
  const inside = useRef(true);
  const settle = useRef(() => {});
  useEffect(() => () => settle.current(), [editing]);
  const onBlur = () => {
    inside.current = false;
    settle.current();
    settle.current = afterPress(() => {
      const root = editRef.current;
      if (!root || inside.current || root.contains(document.activeElement) || root.querySelector('[aria-invalid="true"]')) return;
      stopRef.current(false);
    });
  };
  const onFocus = () => {
    inside.current = true;
  };

  const commit = (edit: EditValue) => {
    const saved = onCommit(edit);
    if (saved) setHeld(saved);
    // Long text saves as it is typed; everything else is done when it commits.
    if (!long && !direct) stop(true);
  };

  const box = cn(
    "w-full min-w-0 rounded-md border border-transparent px-2 text-left text-[0.8125rem]",
    shape === "long_text" ? (field.type === "long_text" && field.options.rich ? "min-h-[8rem] px-2.5 py-2" : "min-h-[5.5rem] py-1.5") : "flex min-h-8 flex-col justify-center py-1 pointer-coarse:min-h-11",
  );

  if (direct) {
    return (
      <div
        className={cn(box, "flex-row items-center justify-start hover:bg-hover")}
        onClick={(e) => {
          // The padding around the control counts as the control.
          if (!(e.target as Element).closest("label, button")) e.currentTarget.querySelector<HTMLElement>("input, button")?.click();
        }}
      >
        <FieldEditor key={`${field.id}:direct`} field={field} value={shown} variant="form" bare labelledBy={labelId} onCommit={commit} onCancel={() => {}} />
      </div>
    );
  }

  if (editing) {
    return (
      <EditSessionProvider value={session}>
        <div ref={editRef} onFocus={onFocus} onBlur={onBlur} data-escape-cancels={long ? undefined : ""}>
          <FieldEditor key={editorKey} field={field} value={shown} variant="form" labelledBy={labelId} autoFocus onChange={onChange} onCommit={commit} onCancel={() => stop(true)} />
        </div>
      </EditSessionProvider>
    );
  }

  const start = () => setEditing(true);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const hit = (e.target as Element).closest(INTERACTIVE);
    if (hit && hit !== e.currentTarget) return;
    // Dragging over the text to copy it ends in a click.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return;
    start();
  };
  // Enter starts at once; Space on release, like a button, so the release does not land on the editor's first button.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      start();
    } else if (e.key === " ") e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && e.key === " ") start();
  };

  return (
    <div
      ref={viewRef}
      role="button"
      tabIndex={0}
      aria-label={`Edit ${field.name}`}
      aria-describedby={describedBy}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      className={cn(box, "outline-none hover:bg-hover focus-visible:border-ring", PICKERS.has(shape) ? "cursor-pointer" : "cursor-text")}
    >
      <div id={describedBy} className="min-w-0">
        {isEmpty(shown) ? <span className="text-faint">Empty</span> : <CellValue field={field} value={shown} format={format} emails={emails} linkFiles />}
      </div>
    </div>
  );
}
