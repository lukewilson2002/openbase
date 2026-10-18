/**
 * The pieces of the capture box that appear once a table is picked: the line saying where it will
 * be saved, the table's primary field as a title, the choosers for the field that takes the note
 * and the one that takes the files, and the table's other fields (the same editors as the expanded
 * record's form).
 */
import { useId, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { Field, WorkspaceSummary } from "@/api/types";
import { EntityTile } from "@/components/icons/EntityIcon";
import { EditorEnvProvider } from "@/components/record/editors/env";
import { FieldEditor } from "@/components/record/editors/FieldEditor";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { IconButton } from "@/components/ui/icon-button";
import { Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { displayShapeOf, type DisplayShape } from "@/lib/cells/kinds";
import { NOTE_AS_COMMENT, attachmentFields, formFields, isTextTitle, noteFields, primaryField, type TargetRef } from "./targets";
import type { TargetForm } from "./useTargetForm";

/** "Saving to Acme › Project tracker › Tasks", with Change and Remove. */
export function TargetBar({ form, target, workspaces, onChange, onRemove }: { form: TargetForm; target: TargetRef; workspaces: readonly WorkspaceSummary[]; onChange: () => void; onRemove: () => void }) {
  const base = workspaces.flatMap((w) => w.bases).find((b) => b.id === target.baseId);
  const table = base?.tables.find((t) => t.id === target.tableId) ?? form.table;
  return (
    <div className="flex min-w-0 items-center gap-2 text-[0.8125rem]">
      {base && <EntityTile name={base.name} icon={base.icon} color={base.color} size="sm" />}
      <p className="min-w-0 flex-1 break-words leading-snug">
        <span className="text-muted">Saving to </span>
        <span className="font-semibold">{[base?.name, table?.name].filter(Boolean).join(" › ") || "this table"}</span>
      </p>
      <button type="button" onClick={onChange} className="shrink-0 rounded px-1.5 py-1 font-semibold text-muted hover:bg-hover hover:text-fg pointer-coarse:py-2.5">
        Change
      </button>
      <IconButton label="Save as a plain note instead" size="sm" noTooltip onClick={onRemove}>
        <X aria-hidden className="size-4" />
      </IconButton>
    </div>
  );
}

/** What the form shows while the table's fields load, or when they cannot. */
export function FormStatus({ form }: { form: TargetForm }) {
  if (form.loading) {
    return (
      <div className="flex justify-center py-3">
        <Spinner className="size-4" label="Loading the table" />
      </div>
    );
  }
  if (form.failed) {
    return (
      <p role="alert" className="text-[0.8125rem] text-danger">
        This table could not be opened. It may have been deleted, or you may have lost access. Choose another one.
      </p>
    );
  }
  return null;
}

/**
 * A primary field that is not text gets its own editor below the title (a text primary is the draft's
 * title itself, see `Capture`).
 */
export function TitleField({ form }: { form: TargetForm }) {
  const table = form.table;
  const field = table ? primaryField(table) : undefined;
  if (!table || !field || !form.env || isTextTitle(field)) return null;
  const error = form.errors[field.id];
  return (
    <EditorEnvProvider value={form.env}>
      <EditorRow key={`${field.id}:${form.generation}`} field={field} form={form} />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </EditorEnvProvider>
  );
}

/**
 * Where the note goes: a long text field of the table, a comment on the new record, or nowhere. A curved
 * arrow from the note box above points at the choice; "Note goes into" is its name for screen readers.
 */
export function NoteChooser({ form }: { form: TargetForm }) {
  const id = useId();
  const table = form.table;
  if (!table) return null;
  const fields = noteFields(table);
  return (
    <div className="-mt-3 flex items-center gap-1.5 text-[0.8125rem]">
      <label htmlFor={id} className="sr-only">
        Note goes into
      </label>
      {/* From the box's bottom edge, down and round to the right. */}
      <svg aria-hidden viewBox="0 0 30 33" className="ml-3 h-[33px] w-[30px] shrink-0 self-start text-faint pointer-coarse:translate-y-1" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 1 C3 18 9 28 26 28" />
        <path d="M21 23 L26 28 L21 33" />
      </svg>
      <div className="mt-2.5 min-w-[10rem] max-w-[16rem] flex-1">
        <Select id={id} value={form.noteFieldId ?? ""} onChange={(e) => form.setNoteField(e.target.value || null)} className="h-9 pointer-coarse:h-11">
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
          <option value={NOTE_AS_COMMENT}>As a comment</option>
          <option value="">Nowhere (discard on save)</option>
        </Select>
      </div>
    </div>
  );
}

/** "Files go into: [field]", for a table with several attachment fields; a note when there is none. */
export function FileChooser({ form, count }: { form: TargetForm; count: number }) {
  const id = useId();
  const table = form.table;
  if (!table || count === 0) return null;
  const fields = attachmentFields(table);
  if (fields.length === 0) {
    return <p className="text-[0.8125rem] text-muted">This table has no attachment field, so the {count === 1 ? "file is" : "files are"} left out of the record.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem]">
      <label htmlFor={id} className="text-muted">
        {count === 1 ? "File goes" : "Files go"} into
      </label>
      <div className="min-w-[10rem] max-w-[16rem] flex-1">
        <Select id={id} value={form.fileFieldId ?? ""} onChange={(e) => form.setFileField(e.target.value || null)} className="h-9 pointer-coarse:h-11">
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
          <option value="">Nowhere (leave out)</option>
        </Select>
      </div>
    </div>
  );
}

/** The table's other fields, one editor each. */
export function OtherFields({ form }: { form: TargetForm }) {
  const [all, setAll] = useState(false);
  const table = form.table;
  if (!table || !form.env) return null;
  const fields = formFields(table, form.noteFieldId);
  if (fields.length === 0) return null;
  // A table with many fields would push Save far down: the rest is one tap away.
  const shown = all ? fields : fields.slice(0, FIELDS_SHOWN);
  return (
    <EditorEnvProvider value={form.env}>
      <div className="flex flex-col gap-3.5 border-t border-line pt-4">
        {shown.map((f) => (
          <FieldRow key={`${f.id}:${form.generation}`} field={f} form={form} />
        ))}
        {fields.length > FIELDS_SHOWN && (
          <button type="button" aria-expanded={all} onClick={() => setAll((a) => !a)} className="flex h-9 items-center gap-1 self-start rounded-[10px] px-1.5 text-[0.8125rem] font-medium text-muted hover:bg-hover hover:text-fg pointer-coarse:h-11">
            <ChevronDown aria-hidden className={cn("size-4 transition-transform", all && "rotate-180")} />
            {all ? "Show fewer fields" : `Show ${fields.length - FIELDS_SHOWN} more ${fields.length - FIELDS_SHOWN === 1 ? "field" : "fields"}`}
          </button>
        )}
      </div>
    </EditorEnvProvider>
  );
}

/** How many of the table's other fields are shown before "Show more". */
const FIELDS_SHOWN = 5;

function FieldRow({ field, form }: { field: Field; form: TargetForm }) {
  const labelId = useId();
  const error = form.errors[field.id];
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3" role="group" aria-labelledby={labelId}>
      <div className="flex min-w-0 items-start gap-1.5 pt-1.5">
        <FieldTypeIcon type={field.type} className="mt-0.5" />
        <h3 id={labelId} className="min-w-0 truncate text-[0.8125rem] font-medium" title={field.description ?? undefined}>
          {field.name}
        </h3>
      </div>
      <div className="min-w-0">
        <EditorRow field={field} form={form} labelledBy={labelId} />
        {error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** Fields typed into with a keyboard: they report every keystroke, so a quick Save never misses the last one. */
const TYPED_SHAPES: ReadonlySet<DisplayShape> = new Set<DisplayShape>(["text", "long_text", "number", "email", "url", "phone"]);

/**
 * One field's editor, reporting into the form. Like the expanded record, a picker is rebuilt when its
 * value changes under it; a text box is not (its own state follows the typing, and a rebuild would
 * take the caret away).
 */
function EditorRow({ field, form, labelledBy }: { field: Field; form: TargetForm; labelledBy?: string }) {
  const value = form.values[field.id] ?? null;
  const typed = TYPED_SHAPES.has(displayShapeOf(field));
  return (
    <FieldEditor
      key={typed ? field.id : `${field.id}:${JSON.stringify(value)}`}
      field={field}
      value={value}
      variant="form"
      labelledBy={labelledBy}
      onChange={typed ? (edit) => form.edit(field, edit, false) : undefined}
      onCommit={(edit) => form.edit(field, edit, true)}
      onCancel={() => {}}
    />
  );
}
