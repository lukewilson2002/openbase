/**
 * Formula text area with field-name autocomplete after `{` and a live check against
 * `POST /api/tables/{id}/formula/check` when the server offers it (a 404 turns the preview off).
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { isApiError } from "@/api/client";
import { schemaApi } from "@/api/records";
import type { Field } from "@/api/types";
import { useDebounced } from "@/components/record/editors/useDebounced";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/cn";

export interface FormulaEditorProps {
  tableId: string;
  /** Fields whose names can be referenced as `{Name}`. */
  fields: readonly Field[];
  value: string;
  onChange: (expression: string) => void;
  label: string;
  placeholder?: string;
  /** "rollup" formulas run over the array `values`. */
  kind?: "formula" | "rollup";
  rows?: number;
}

interface Completion {
  /** Index of the `{` that opened the reference. */
  start: number;
  query: string;
}

/** The unfinished `{reference` ending at `caret`, if any. */
export function openReference(text: string, caret: number): Completion | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf("{");
  if (open < 0) return null;
  const inner = before.slice(open + 1);
  if (inner.includes("}") || inner.includes("\n")) return null;
  return { start: open, query: inner };
}

/** Insert the chosen field name, closing the brace. */
export function applyCompletion(text: string, caret: number, c: Completion, fieldName: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const next = `${text.slice(0, c.start)}{${fieldName}}${after.startsWith("}") ? after.slice(1) : after}`;
  return { text: next, caret: c.start + fieldName.length + 2 };
}

type CheckState = { status: "idle" } | { status: "checking" } | { status: "ok"; preview?: string } | { status: "error"; message: string } | { status: "unavailable" };

export function FormulaEditor({ tableId, fields, value, onChange, label, placeholder, kind = "formula", rows = 4 }: FormulaEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const unavailable = useRef(false);

  const completion = useMemo(() => (dismissed ? null : openReference(value, caret)), [value, caret, dismissed]);
  const suggestions = useMemo(() => {
    if (!completion) return [];
    const q = completion.query.toLowerCase();
    return fields.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 8);
  }, [completion, fields]);

  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(at, at);
    setCaret(at);
  });

  const accept = (f: Field) => {
    if (!completion) return;
    const out = applyCompletion(value, caret, completion, f.name);
    pendingCaret.current = out.caret;
    onChange(out.text);
  };

  const debounced = useDebounced(value, 500);
  useEffect(() => {
    if (!debounced.trim() || unavailable.current) {
      setCheck(unavailable.current ? { status: "unavailable" } : { status: "idle" });
      return;
    }
    const ctl = new AbortController();
    setCheck({ status: "checking" });
    schemaApi
      .checkFormula(tableId, debounced, kind, ctl.signal)
      .then((res) => {
        if (res && res.ok === false) setCheck({ status: "error", message: res.error || "The formula is not valid." });
        else if (res?.error) setCheck({ status: "error", message: res.error });
        else setCheck({ status: "ok", preview: res?.preview === undefined || res.preview === null ? undefined : String(res.preview) });
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (isApiError(e) && (e.status === 404 || e.status === 405)) {
          unavailable.current = true;
          setCheck({ status: "unavailable" });
        } else if (isApiError(e) && e.status === 400) setCheck({ status: "error", message: e.message });
        else setCheck({ status: "idle" });
      });
    return () => ctl.abort();
  }, [debounced, tableId, kind]);

  return (
    <div className="relative">
      <label htmlFor={`${listId}-ta`} className="text-[0.8125rem] font-medium">
        {label}
      </label>
      <Textarea
        id={`${listId}-ta`}
        ref={ref}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder ?? "e.g. {Price} * {Quantity}"}
        className="mt-1 font-mono text-[0.8125rem]"
        value={value}
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={suggestions.length > 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setDismissed(false);
          setActive(0);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (suggestions.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => (a + 1) % suggestions.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            const f = suggestions[active];
            if (f) accept(f);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDismissed(true);
          }
        }}
      />
      {suggestions.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Fields" className="absolute left-0 z-20 mt-1 max-h-48 w-64 overflow-y-auto rounded-md border border-line bg-surface p-1 shadow-pop">
          {suggestions.map((f, i) => (
            <li key={f.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
              <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => accept(f)} className={cn("block w-full truncate rounded px-2 py-1 text-left text-[0.8125rem]", i === active && "bg-hover")}>
                {f.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 min-h-5 text-xs" aria-live="polite">
        {check.status === "error" && (
          <p className="flex items-start gap-1 text-danger">
            <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /> {check.message}
          </p>
        )}
        {check.status === "ok" && (
          <p className="flex items-center gap-1 text-success">
            <CircleCheck aria-hidden className="size-3.5" /> Looks good{check.preview !== undefined ? <span className="text-muted"> · preview: {check.preview}</span> : null}
          </p>
        )}
        {check.status === "checking" && <p className="text-muted">Checking…</p>}
        {check.status === "unavailable" && <p className="text-muted">Type {"{"} to insert a field name. Formulas are checked when you save.</p>}
        {check.status === "idle" && value.trim() === "" && <p className="text-muted">Type {"{"} to insert a field name.</p>}
      </div>
    </div>
  );
}
