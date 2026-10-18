/**
 * Text-like editors: single line text, long text, numbers, currency, percent, duration,
 * email, URL, phone, barcode, and the text half of date editing. The editor reports the typed
 * text; the host parses it with `parseText` (so grid and expanded record validate identically).
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import type { Field } from "@/api/types";
import { cn } from "@/lib/cn";
import { editText } from "@/lib/cells/format";
import { parseText } from "@/lib/cells/parse";
import { useEditorEnv, type FieldEditorCallbacks, type Move } from "./env";
import { FullScreen } from "./FullScreen";
import { useAutosave } from "./useAutosave";

export interface TextEditorProps extends FieldEditorCallbacks {
  field: Field;
  value: unknown;
  initialText?: string;
  /** `cell` floats over a grid cell and commits on Enter/Tab; `form` is inline and commits on blur. */
  variant: "cell" | "form";
  autoFocus?: boolean;
  /** Extra controls rendered after the input (the date picker button). */
  trailing?: React.ReactNode;
  /** Override the initial display text (dates use their own formatting). */
  seedText?: string;
  className?: string;
  labelledBy?: string;
  label?: string;
  /**
   * Long text: shows an expand button in the corner of the box that opens this full screen, given the
   * text so far and a way to change it. The text area and the full-screen view are one value.
   */
  renderFullScreen?: (p: { value: string; onChange: (text: string) => void }) => ReactNode;
}

const HINTS: Partial<Record<Field["type"], string>> = {
  percent: "e.g. 12.5%",
  duration: "e.g. 1:30 or 1h 30m",
  email: "name@example.com",
  url: "https://",
  phone: "+1 555 010 0000",
};

export function TextEditor({ field, value, initialText, variant, autoFocus, trailing, seedText, className, labelledBy, label, renderFullScreen, onChange, onCommit, onCancel }: TextEditorProps) {
  const env = useEditorEnv();
  const isLong = field.type === "long_text";
  const [fullScreen, setFullScreen] = useState(false);
  const seed = useMemo(() => initialText ?? seedText ?? (typeof value === "string" || typeof value === "number" ? editText(field, value, env.format) : ""), [initialText, seedText, value, field, env.format]);
  const [text, setText] = useState(seed);
  const textRef = useRef(text);
  textRef.current = text;
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const errorId = useId();
  const doneRef = useRef(false);
  // Long text in the expanded record saves while typing (once typing pauses) and on blur, so the
  // record's save status follows it. Everything else commits on blur or Enter.
  const autosaves = isLong && variant === "form";
  const autosave = useAutosave(seed, (t) => onCommit({ text: t }));

  const error = useMemo(() => {
    if (isLong || text.trim() === "") return null;
    const r = parseText(field, text, { timeZone: env.timeZone, users: env.collaborators });
    return r.ok ? null : r.error;
  }, [text, field, env.timeZone, env.collaborators, isLong]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || !(autoFocus ?? variant === "cell")) return;
    el.focus();
    // Typing to start an edit puts the caret after the typed text; Enter/double-click selects nothing special.
    const end = el.value.length;
    el.setSelectionRange(end, end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  // A value typed to start the edit is the first thing to report. Later edits are reported straight
  // from the input handler: the host (the grid's overlay) commits what it was last told when the
  // editor refuses to (an invalid value) and Enter falls through to it, so a report that waited for
  // an effect could be a keystroke behind.
  useEffect(() => {
    if (initialText !== undefined) onChange?.({ text: initialText });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (move?: Move) => {
    if (doneRef.current) return;
    if (error) return; // keep the editor open so the message can be read
    doneRef.current = true;
    onCommit({ text: textRef.current }, move);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Escape in the record's long text closes the record, which saves what was typed; nothing to cancel.
    if (e.key === "Escape" && !autosaves) {
      e.preventDefault();
      doneRef.current = true;
      onCancel();
    } else if (e.key === "Enter" && !(isLong && e.shiftKey)) {
      if (isLong && variant === "form") return; // plain Enter adds a line in the form's text area
      e.preventDefault();
      // In the grid, Enter and Tab also reach the overlay's own handler, which would close the editor
      // and commit whatever it last heard. When the value is invalid the editor must stay open with its
      // message, so the key stops here.
      e.stopPropagation();
      finish(variant === "cell" ? [0, e.shiftKey ? -1 : 1] : undefined);
    } else if (e.key === "Tab" && variant === "cell") {
      e.preventDefault();
      e.stopPropagation();
      finish([e.shiftKey ? -1 : 1, 0]);
    }
  };

  /** The text changed (typed, or edited in the full-screen view). */
  const update = (next: string) => {
    setText(next);
    onChange?.({ text: next });
    if (autosaves) autosave.change(next);
  };

  const common = {
    ref: inputRef as never,
    value: text,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update(e.target.value),
    onKeyDown,
    onBlur: () => {
      if (autosaves) autosave.flush();
      else if (variant === "form" && !doneRef.current) {
        if (textRef.current === seed) return;
        if (!error) onCommit({ text: textRef.current });
      }
    },
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? errorId : undefined,
    "aria-labelledby": labelledBy,
    "aria-label": label ?? field.name,
    placeholder: HINTS[field.type],
    spellCheck: field.type === "single_line_text" || isLong,
  };

  const box = cn(
    variant === "cell" ? "min-w-full rounded-sm border-2 border-primary bg-surface shadow-pop" : "rounded-md border border-line-strong bg-surface hover:border-faint focus-within:border-ring",
    error && "border-danger",
    className,
  );

  return (
    <div className={cn("relative flex items-start text-[0.8125rem]", box)} style={variant === "cell" ? { minWidth: "100%" } : undefined}>
      {isLong ? (
        <textarea {...common} rows={variant === "cell" ? 4 : 5} className={cn("min-h-[5.5rem] w-full resize-y bg-transparent px-2 py-1.5 outline-none", renderFullScreen && "pb-9")} style={variant === "cell" ? { minWidth: 280 } : undefined} />
      ) : (
        <input
          {...common}
          type="text"
          inputMode={field.type === "number" || field.type === "currency" || field.type === "percent" ? "decimal" : undefined}
          className="h-8 w-full min-w-0 bg-transparent px-2 outline-none"
        />
      )}
      {trailing}
      {isLong && renderFullScreen && (
        <>
          <button
            type="button"
            aria-label="Open full screen"
            title="Open full screen"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFullScreen(true)}
            className="absolute bottom-1.5 right-1.5 inline-flex size-7 pointer-coarse:size-10 items-center justify-center rounded-md border border-line bg-surface text-muted hover:bg-hover hover:text-fg"
          >
            <Maximize2 aria-hidden className="size-4" />
          </button>
          {fullScreen && (
            <FullScreen
              title={field.name}
              onClose={() => {
                setFullScreen(false);
                // Back in the text area, with the caret where the user will want it.
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              {renderFullScreen({ value: text, onChange: update })}
            </FullScreen>
          )}
        </>
      )}
      {error && (
        <p id={errorId} role="alert" className="absolute left-0 top-full z-10 mt-1 rounded bg-danger px-2 py-1 text-xs text-danger-fg shadow-pop">
          {error}
        </p>
      )}
    </div>
  );
}
