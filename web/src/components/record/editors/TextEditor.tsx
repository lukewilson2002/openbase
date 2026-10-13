/**
 * Text-like editors: single line text, long text, numbers, currency, percent, duration,
 * email, URL, phone, barcode, and the text half of date editing. The editor reports the typed
 * text; the host parses it with `parseText` (so grid and expanded record validate identically).
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Field } from "@/api/types";
import { cn } from "@/lib/cn";
import { editText } from "@/lib/cells/format";
import { parseText } from "@/lib/cells/parse";
import { useEditorEnv, type FieldEditorCallbacks, type Move } from "./env";

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
}

const HINTS: Partial<Record<Field["type"], string>> = {
  percent: "e.g. 12.5%",
  duration: "e.g. 1:30 or 1h 30m",
  email: "name@example.com",
  url: "https://",
  phone: "+1 555 010 0000",
};

export function TextEditor({ field, value, initialText, variant, autoFocus, trailing, seedText, className, labelledBy, label, onChange, onCommit, onCancel }: TextEditorProps) {
  const env = useEditorEnv();
  const isLong = field.type === "long_text";
  const seed = useMemo(() => initialText ?? seedText ?? (typeof value === "string" || typeof value === "number" ? editText(field, value, env.format) : ""), [initialText, seedText, value, field, env.format]);
  const [text, setText] = useState(seed);
  const textRef = useRef(text);
  textRef.current = text;
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const errorId = useId();
  const doneRef = useRef(false);

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

  const firstRun = useRef(true);
  useEffect(() => {
    // Report edits (not the initial seed) so an outside click can commit them and previews can follow.
    if (firstRun.current) {
      firstRun.current = false;
      if (initialText === undefined) return;
    }
    onChange?.({ text });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const finish = (move?: Move) => {
    if (doneRef.current) return;
    if (error) return; // keep the editor open so the message can be read
    doneRef.current = true;
    onCommit({ text: textRef.current }, move);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      doneRef.current = true;
      onCancel();
    } else if (e.key === "Enter" && !(isLong && e.shiftKey)) {
      if (isLong && variant === "form") return; // plain Enter adds a line in the form's text area
      e.preventDefault();
      finish(variant === "cell" ? [0, e.shiftKey ? -1 : 1] : undefined);
    } else if (e.key === "Tab" && variant === "cell") {
      e.preventDefault();
      finish([e.shiftKey ? -1 : 1, 0]);
    }
  };

  const common = {
    ref: inputRef as never,
    value: text,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    onKeyDown,
    onBlur: () => {
      if (variant === "form" && !doneRef.current) {
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
        <textarea {...common} rows={variant === "cell" ? 4 : 5} className="min-h-[5.5rem] w-full resize-y bg-transparent px-2 py-1.5 outline-none" style={variant === "cell" ? { minWidth: 280 } : undefined} />
      ) : (
        <input
          {...common}
          type="text"
          inputMode={field.type === "number" || field.type === "currency" || field.type === "percent" ? "decimal" : undefined}
          className="h-8 w-full min-w-0 bg-transparent px-2 outline-none"
        />
      )}
      {trailing}
      {error && (
        <p id={errorId} role="alert" className="absolute left-0 top-full z-10 mt-1 rounded bg-danger px-2 py-1 text-xs text-danger-fg shadow-pop">
          {error}
        </p>
      )}
    </div>
  );
}
