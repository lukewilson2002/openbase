/**
 * The record's properties as the page shows them until the property list replaces this (REC-3): one row per
 * property of the collection's default view, each shown rendered and turned into its editor when clicked
 * (EditableValue), hidden ones in a collapsible section.
 */
import { useMemo, useRef, useState, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { Field, Table, TableRecord, ViewConfig } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { EditableValue } from "@/components/record/EditableValue";
import type { EditValue, EditorEnv } from "@/components/record/editors/env";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { resolveFieldOrder } from "@/components/viewbar/config";
import { jsonEqual } from "@/lib/cells/parse";
import { isComputed, isMultilineText } from "@/lib/cells/kinds";
import { cn } from "@/lib/cn";
import type { RecordSave, Unsent } from "./useRecordSave";

function FieldRow({
  field,
  record,
  readOnly,
  error,
  env,
  emails,
  lastSaved,
  unsent,
  failed,
  startEditing,
  onSave,
}: {
  field: Field;
  record: TableRecord;
  readOnly: boolean;
  error?: string;
  env: EditorEnv;
  emails: ReadonlyMap<string, string>;
  lastSaved: RefObject<Map<string, unknown>>;
  /** Which multiline text fields have text of ours that is typed but not sent yet, or sent and not answered yet. */
  unsent: RefObject<Unsent>;
  /** The value of this field that could not be saved, kept for the person to correct. */
  failed?: { value: unknown };
  /** The field starts being edited (the primary field of a record just added). */
  startEditing: boolean;
  onSave: (field: Field, edit: EditValue) => { value: unknown } | undefined;
}) {
  const value = record.values[field.id] ?? null;
  const computed = isComputed(field);
  const labelId = `field-${field.id}`;
  // An editor is rebuilt when its value changes under it (someone else edited it, a save was refused). Long
  // text saves while it is typed in, so a value that is only our own save coming back must not rebuild the
  // editor, or the caret would jump out from under the typing. Nor is it rebuilt while text of ours is typed
  // but not sent, or sent but not answered: a refetch in that time answers with what the server held before
  // (the text being typed would be replaced by it, and the next keystroke would save the stale text).
  const textKey = `${record.id}:${field.id}`;
  const rebuilds = useRef({ json: JSON.stringify(value), n: 0 });
  const typedIn = isMultilineText(field);
  if (typedIn) {
    const json = JSON.stringify(value);
    if (json !== rebuilds.current.json) {
      rebuilds.current.json = json;
      if (!jsonEqual(value, lastSaved.current.get(textKey) ?? null) && !unsent.current.isWaiting(textKey)) rebuilds.current.n++;
    }
  }
  const editorKey = typedIn ? `${record.id}:${field.id}:${rebuilds.current.n}` : `${record.id}:${field.id}:${JSON.stringify(value)}`;
  return (
    <div className="grid gap-1 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-3" role="group" aria-labelledby={labelId}>
      {/* The field's name edits it too (the value's own box, or its checkbox or stars), as a form's label does. */}
      <div
        className={cn("flex min-w-0 items-start gap-1.5 pt-1.5", !(readOnly || computed) && "cursor-pointer")}
        onClick={readOnly || computed ? undefined : (e) => e.currentTarget.parentElement?.querySelector<HTMLElement>("[data-edit-field]")?.click()}
      >
        <FieldTypeIcon type={field.type} className="mt-0.5" />
        <div className="min-w-0">
          <h3 id={labelId} className="truncate text-label font-medium" title={field.description ?? undefined}>
            {field.name}
          </h3>
          {field.description && <p className="line-clamp-2 text-meta text-muted">{field.description}</p>}
        </div>
      </div>
      <div className="min-w-0">
        {readOnly || computed ? (
          <div className={cn("rounded-md px-2 py-1.5", computed ? "bg-subtle/60" : "")}>
            <CellValue field={field} value={value} format={env.format} emails={emails} />
            {computed && <span className="sr-only"> (computed, read-only)</span>}
          </div>
        ) : (
          <EditableValue
            key={record.id}
            field={field}
            value={value}
            failed={failed}
            labelId={labelId}
            format={env.format}
            emails={emails}
            editorKey={editorKey}
            startEditing={startEditing}
            onChange={typedIn ? (edit) => unsent.current.typed(textKey, edit.text !== undefined && edit.text !== (typeof value === "string" ? value : "")) : undefined}
            onCommit={(edit) => onSave(field, edit)}
          />
        )}
        {error && (
          <p role="alert" className="mt-1 text-meta text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export interface RecordFieldsProps {
  table: Table;
  record: TableRecord;
  /** Property order and which are hidden: the collection's default view. */
  config?: Pick<ViewConfig, "field_order" | "hidden_fields">;
  readOnly: boolean;
  env: EditorEnv;
  emails: ReadonlyMap<string, string>;
  save: RecordSave;
  /** The record was just added: its title starts being edited. */
  justCreated: boolean;
}

export function RecordFields({ table, record, config, readOnly, env, emails, save, justCreated }: RecordFieldsProps) {
  const [showHidden, setShowHidden] = useState(false);
  const { visible, hidden } = useMemo(() => resolveFieldOrder(table, config ?? { field_order: [], hidden_fields: [] }), [table, config]);
  const row = (f: Field, startEditing: boolean) => (
    <FieldRow key={f.id} field={f} record={record} readOnly={readOnly} error={save.errors[f.id]} failed={save.failed[f.id]} startEditing={startEditing} env={env} emails={emails} lastSaved={save.lastSaved} unsent={save.unsent} onSave={save.onSave} />
  );
  return (
    // Fields sit close: each is as tall as its value, and a hover tints it, which marks it off enough.
    <div className="flex flex-col gap-2">
      {visible.map((f) => row(f, justCreated && f.id === table.primary_field_id))}
      {hidden.length > 0 && (
        <div className="border-t border-line pt-3">
          <button type="button" aria-expanded={showHidden} aria-controls="hidden-fields" onClick={() => setShowHidden((s) => !s)} className="flex items-center gap-1 text-label font-medium text-muted hover:text-fg">
            <ChevronDown aria-hidden className={cn("size-4 transition-transform", !showHidden && "-rotate-90")} />
            {showHidden ? "Hide" : "Show"} {hidden.length} hidden field{hidden.length === 1 ? "" : "s"}
          </button>
          {showHidden && (
            <div id="hidden-fields" className="mt-3 flex flex-col gap-2">
              {hidden.map((f) => row(f, false))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
