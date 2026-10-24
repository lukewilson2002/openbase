/**
 * The form as a person fills it in: title, description, one editor per field (the record
 * editors in their `form` variant) with the label, help text and required marker the builder
 * set, and a footer for the submit button. Used by the builder's live preview and by the internal
 * "fill in form" mode; the public page has its own lightweight inputs (`public/`).
 *
 * Fields the public form does not collect (links, users, fields the view hides) are marked
 * "Signed-in editors only" so the builder shows what visitors will actually get.
 *
 * With `onSubmit` the form sends on Enter in a one-line input and on Ctrl or Cmd+Enter anywhere in it.
 */
import { Fragment, type KeyboardEvent, type ReactNode } from "react";
import { Lock } from "lucide-react";
import type { Field, FormConfig, FormField, Table } from "@/api/types";
import { FieldEditor } from "@/components/record/editors/FieldEditor";
import type { EditValue } from "@/components/record/editors/env";
import { cn } from "@/lib/cn";
import { liveEntries, publicStatus } from "@/lib/forms/formConfig";
import type { Drafts } from "@/lib/forms/drafts";

export interface FormSurfaceProps {
  title: string;
  /** Accessible name of the form region. */
  label?: string;
  form: FormConfig;
  table: Pick<Table, "fields">;
  hiddenFields: readonly string[];
  /** Show only what a visitor of the public link gets. */
  publicOnly?: boolean;
  /** Current drafts (to restore values when editors remount). */
  drafts: Drafts;
  onEdit: (field: Field, edit: EditValue) => void;
  /** Problems by field id. */
  errors: Readonly<Record<string, string>>;
  /** Changes when the form is cleared, so every editor starts over. */
  resetKey: number;
  /** Submit button area. */
  footer?: ReactNode;
  /** Small notice above the fields (for example "Preview: nothing is saved"). */
  banner?: ReactNode;
  /** Width of the card (the preview is narrower than "Fill in form"). */
  className?: string;
  /** Sends the form: Enter in a one-line input and Ctrl or Cmd+Enter anywhere in it call this. */
  onSubmit?: () => void;
  /** The preview: nothing may leave the page, so a field that would upload files is only shown. */
  inert?: boolean;
  /** Draws a field in place of the signed-in editor (the preview of the public form uses the visitors' inputs). */
  renderField?: (entry: FormField, field: Field) => ReactNode;
}

/** Input types that are typed into one line, where Enter means "send". */
const ONE_LINE_INPUTS = new Set(["text", "email", "url", "tel", "number", "search", "date", "datetime-local", "time", "month", "week", "password"]);

function sendsOnEnter(e: KeyboardEvent<HTMLElement>): boolean {
  if (e.key !== "Enter" || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return false;
  // Only what is inside the form: a picker's pop-over is drawn elsewhere and uses Enter for itself.
  const target = e.target as HTMLElement;
  if (!e.currentTarget.contains(target)) return false;
  if (e.ctrlKey || e.metaKey) return true;
  if (target.tagName !== "INPUT" || target.getAttribute("role") === "combobox") return false;
  return ONE_LINE_INPUTS.has((target as HTMLInputElement).type);
}

/** The value an editor starts with: what was last entered (JSON drafts only; typed text restarts empty). */
function initialValue(drafts: Drafts, field: Field): unknown {
  const d = drafts[field.id];
  return d && d.json !== undefined ? d.json : null;
}

function FieldBlock({
  entry,
  field,
  internalOnlyNote,
  error,
  value,
  onEdit,
  inert,
}: {
  entry: FormField;
  field: Field;
  internalOnlyNote: string | null;
  error?: string;
  value: unknown;
  onEdit: FormSurfaceProps["onEdit"];
  inert?: boolean;
}) {
  const labelId = `form-field-${field.id}`;
  const label = entry.label?.trim() || field.name;
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-labelledby={labelId} data-field-id={field.id}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span id={labelId} className="text-[0.875rem] font-semibold">
          {label}
          {entry.required && (
            <span aria-hidden className="ml-0.5 text-danger">
              *
            </span>
          )}
        </span>
        {internalOnlyNote && (
          <span className="inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 text-xs text-muted" title={internalOnlyNote}>
            <Lock aria-hidden className="size-3" /> Signed-in editors only
          </span>
        )}
      </div>
      {entry.help?.trim() && <p className="whitespace-pre-wrap text-[0.8125rem] text-muted">{entry.help}</p>}
      {inert && field.type === "attachment" ? (
        <p className="rounded-md border border-dashed border-line-strong px-3 py-2 text-[0.8125rem] text-muted">
          Files cannot be added in the preview.
        </p>
      ) : (
        <FieldEditor
          // The date editor shows text seeded from its value, so a date picked in the calendar needs a fresh editor.
          key={field.type === "date" ? JSON.stringify(value) : undefined}
          field={field}
          value={value}
          variant="form"
          labelledBy={labelId}
          onChange={(edit) => onEdit(field, edit)}
          onCommit={(edit) => onEdit(field, edit)}
          onCancel={() => {}}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormSurface({
  title,
  label = "Form",
  form,
  table,
  hiddenFields,
  publicOnly,
  drafts,
  onEdit,
  errors,
  resetKey,
  footer,
  banner,
  className,
  onSubmit,
  inert,
  renderField,
}: FormSurfaceProps) {
  const entries = liveEntries(form, table);
  const shown = entries.filter(({ field }) => !publicOnly || publicStatus(field, hiddenFields).public);
  const anyRequired = shown.some((e) => e.entry.required);
  return (
    <section
      aria-label={label}
      onKeyDownCapture={
        onSubmit
          ? (e) => {
              if (!sendsOnEnter(e)) return;
              e.preventDefault();
              onSubmit();
            }
          : undefined
      }
      className={cn(
        "mx-auto flex w-full max-w-[600px] flex-col gap-[18px] rounded-[14px] border border-line bg-surface px-5 py-6 shadow-[0_10px_28px_rgb(15_20_30/0.06)] sm:px-8 sm:pb-[30px] sm:pt-7",
        className,
      )}
    >
      {banner}
      <header className="flex flex-col gap-1.5">
        <h2 className="text-[1.375rem] leading-tight tracking-[-0.01em]">{form.title.trim() || title}</h2>
        {form.description.trim() && <p className="whitespace-pre-wrap text-[0.9375rem] leading-normal text-muted">{form.description}</p>}
        {anyRequired && <p className="text-xs text-muted">Fields marked * are required.</p>}
      </header>
      {shown.length === 0 ? (
        <p className="rounded-md bg-subtle px-3 py-4 text-center text-[0.8125rem] text-muted">
          {entries.length === 0 ? "This form has no fields yet." : "None of this form's fields are collected by the public form."}
        </p>
      ) : (
        <div className="flex flex-col gap-[18px]">
          {shown.map(({ entry, field }) => {
            const status = publicStatus(field, hiddenFields);
            const custom = renderField?.(entry, field);
            if (custom) return <Fragment key={`${field.id}:${resetKey}`}>{custom}</Fragment>;
            return (
              <FieldBlock
                key={`${field.id}:${resetKey}`}
                entry={entry}
                field={field}
                internalOnlyNote={status.public ? null : status.message}
                error={errors[field.id]}
                value={initialValue(drafts, field)}
                onEdit={onEdit}
                inert={inert}
              />
            );
          })}
        </div>
      )}
      {footer}
    </section>
  );
}
