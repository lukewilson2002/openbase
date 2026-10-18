/**
 * Date editor: a text box that accepts many formats (parsed like pasted text) plus a button that
 * opens the browser's native date or date-time picker. Times are interpreted in the field's
 * fixed time zone, or the viewer's zone when the field has none (shown in the hint).
 */
import { useId, useRef } from "react";
import { CalendarDays } from "lucide-react";
import type { DateOptions, Field } from "@/api/types";
import { fieldZone, fromInputValue, toInputValue } from "@/lib/cells/dates";
import { dateOptionsOf } from "@/lib/cells/kinds";
import { formatStoredDate } from "@/lib/cells/dates";
import { TextEditor } from "./TextEditor";
import { useEditorEnv, type FieldEditorCallbacks } from "./env";

export interface DateEditorProps extends FieldEditorCallbacks {
  field: Field;
  value: unknown;
  initialText?: string;
  variant: "cell" | "form";
  autoFocus?: boolean;
}

const DEFAULT_OPTS: DateOptions = { include_time: false, date_format: "us", time_format: "h12", timezone: null };

export function DateEditor({ field, value, initialText, variant, autoFocus, onChange, onCommit, onCancel }: DateEditorProps) {
  const env = useEditorEnv();
  const opts = dateOptionsOf(field) ?? DEFAULT_OPTS;
  const pickerRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const zone = fieldZone(opts, env.timeZone);

  const picker = (
    <>
      <input
        ref={pickerRef}
        type={opts.include_time ? "datetime-local" : "date"}
        tabIndex={-1}
        aria-label={`Pick a ${opts.include_time ? "date and time" : "date"} for ${field.name}`}
        value={toInputValue(value, opts, env.timeZone)}
        onChange={(e) => {
          const iso = fromInputValue(e.target.value, opts, env.timeZone);
          if (iso) onCommit({ json: iso });
        }}
        className="pointer-events-none absolute right-0 top-0 h-8 w-8 opacity-0"
      />
      <button
        type="button"
        aria-label="Open calendar"
        aria-describedby={hintId}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const el = pickerRef.current;
          if (!el) return;
          try {
            el.showPicker();
          } catch {
            el.focus();
          }
        }}
        className="flex h-8 w-8 shrink-0 items-center justify-center text-muted hover:text-fg"
      >
        <CalendarDays aria-hidden className="size-4" />
      </button>
      <span id={hintId} className="sr-only">
        Times use {zone}
      </span>
    </>
  );

  return (
    <div className="relative">
      <TextEditor
        field={field}
        value={value}
        initialText={initialText}
        seedText={formatStoredDate(value, opts, env.timeZone)}
        variant={variant}
        autoFocus={autoFocus}
        trailing={picker}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
      />
      {opts.include_time && <p className="mt-1 text-xs text-muted">Time zone: {zone}</p>}
    </div>
  );
}
