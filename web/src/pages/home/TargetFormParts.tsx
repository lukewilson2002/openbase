/**
 * The pieces of the form an Inbox draft is filed through, once a collection is picked: the collection's title when it
 * is not text, the choosers for the property that takes the note and the one that takes the files, and the other
 * properties (the same editors as the record page).
 */
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Field } from "@/api/types";
import { EditorEnvProvider } from "@/components/record/editors/env";
import { FieldEditor } from "@/components/record/editors/FieldEditor";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { displayShapeOf, type DisplayShape } from "@/lib/cells/kinds";
import { NOTE_AS_COMMENT, attachmentFields, formFields, isTextTitle, noteFields, primaryField } from "./targets";
import type { TargetForm } from "./useTargetForm";

/** What the form shows while the collection's properties load, or when they cannot. */
export function FormStatus({ form }: { form: TargetForm }) {
  if (form.loading) {
    return (
      <div className="flex justify-center py-3">
        <Spinner className="size-4" label="Loading the collection" />
      </div>
    );
  }
  if (form.failed) {
    return (
      <p role="alert" className="text-label text-danger">
        This collection could not be opened. It may have been deleted, or you may have lost access. Choose another one.
      </p>
    );
  }
  return null;
}

/**
 * A title property that is not text gets its own editor below the title (a text primary is the draft's
 * title itself, see `FileDraftDialog`).
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
 * Where the note goes: a rich or multiline text property of the collection, a comment on the new record, or nowhere. A curved
 * arrow from the note box above points at the choice; "Note goes into" is its name for screen readers.
 */
export function NoteChooser({ form }: { form: TargetForm }) {
  const id = useId();
  const table = form.table;
  if (!table) return null;
  const fields = noteFields(table);
  return (
    <div className="-mt-3 flex items-center gap-1.5 text-label">
      <label htmlFor={id} className="sr-only">
        Note goes into
      </label>
      {/* From the box's bottom edge, down and round to the right. */}
      <svg aria-hidden viewBox="0 0 30 33" className="ml-3 h-[33px] w-[30px] shrink-0 self-start text-faint pointer-coarse:translate-y-1" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 1 C3 18 9 28 26 28" />
        <path d="M21 23 L26 28 L21 33" />
      </svg>
      <div className="mt-2.5 min-w-[10rem] max-w-[16rem] flex-1">
        <Select id={id} value={form.noteFieldId ?? ""} onChange={(e) => form.setNoteField(e.target.value || null)} className="h-control-md max-md:h-control-touch pointer-coarse:h-control-touch">
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              Property: {f.name}
            </option>
          ))}
          <option value={NOTE_AS_COMMENT}>As a comment</option>
          <option value="">Nowhere (discard on save)</option>
        </Select>
      </div>
    </div>
  );
}

/** "Files go into: [property]", for a collection with several attachment properties; a note when there is none. */
export function FileChooser({ form, count }: { form: TargetForm; count: number }) {
  const id = useId();
  const table = form.table;
  if (!table || count === 0) return null;
  const fields = attachmentFields(table);
  if (fields.length === 0) {
    return <p className="text-label text-muted">This collection has no attachment property, so the {count === 1 ? "file is" : "files are"} left out of the record.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label">
      <label htmlFor={id} className="text-muted">
        {count === 1 ? "File goes" : "Files go"} into
      </label>
      <div className="min-w-[10rem] max-w-[16rem] flex-1">
        <Select id={id} value={form.fileFieldId ?? ""} onChange={(e) => form.setFileField(e.target.value || null)} className="h-control-md max-md:h-control-touch pointer-coarse:h-control-touch">
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              Property: {f.name}
            </option>
          ))}
          <option value="">Nowhere (leave out)</option>
        </Select>
      </div>
    </div>
  );
}

/** The collection's other properties, one editor each. */
export function OtherFields({ form }: { form: TargetForm }) {
  const [all, setAll] = useState(false);
  const table = form.table;
  if (!table || !form.env) return null;
  const fields = formFields(table, form.noteFieldId);
  if (fields.length === 0) return null;
  // A collection with many properties would push Save far down: the rest is one tap away.
  const shown = all ? fields : fields.slice(0, FIELDS_SHOWN);
  return (
    <EditorEnvProvider value={form.env}>
      <div className="flex flex-col gap-3.5 border-t border-line pt-4">
        {shown.map((f) => (
          <FieldRow key={`${f.id}:${form.generation}`} field={f} form={form} />
        ))}
        {fields.length > FIELDS_SHOWN && (
          <button type="button" aria-expanded={all} onClick={() => setAll((a) => !a)} className="flex h-9 items-center gap-1 self-start rounded-md px-1.5 text-label font-medium text-muted hover:bg-hover hover:text-fg pointer-coarse:h-11">
            <ChevronDown aria-hidden className={cn("size-4 transition-transform", all && "rotate-180")} />
            {all ? "Show fewer properties" : `Show ${fields.length - FIELDS_SHOWN} more ${fields.length - FIELDS_SHOWN === 1 ? "property" : "properties"}`}
          </button>
        )}
      </div>
    </EditorEnvProvider>
  );
}

/** How many of the collection's other properties are shown before "Show more". */
const FIELDS_SHOWN = 5;

function FieldRow({ field, form }: { field: Field; form: TargetForm }) {
  const labelId = useId();
  const error = form.errors[field.id];
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3" role="group" aria-labelledby={labelId}>
      <div className="flex min-w-0 items-start gap-1.5 pt-1.5">
        <FieldTypeIcon type={field.type} className="mt-0.5" />
        <h3 id={labelId} className="min-w-0 truncate text-label font-medium" title={field.description ?? undefined}>
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

/** Properties typed into with a keyboard: they report every keystroke, so a quick Save never misses the last one. */
const TYPED_SHAPES: ReadonlySet<DisplayShape> = new Set<DisplayShape>(["text", "multiline", "number", "email", "url", "phone"]);

/**
 * One property's editor, reporting into the form. Like the record page, a picker is rebuilt when its
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
