/**
 * The properties of a record page (REC-3): a PropertyList of the ones that have a value, in the order and
 * visibility of the collection's default view, less the title and the Page.
 *
 * - Empty properties fold into "Show N empty properties", and properties hidden from pages into "Show N hidden
 *   properties"; both folds are kept per device.
 * - A value is shown as display text and turns into its form editor on a click or tap; it saves on its own.
 *   Computed values, and everything for viewers and commenters, are read-only.
 * - A property's name opens its menu. Creators: Rename, Edit property, Delete. Editors and up: Hide from pages,
 *   or Show on pages for one that is hidden, which edits the default view's layout at once.
 */
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Eye, EyeOff, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";
import { keys } from "@/api/keys";
import { schemaApi } from "@/api/records";
import type { BaseSchema, Field, Table, TableRecord, View } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { EditableValue } from "@/components/record/EditableValue";
import type { EditValue, EditorEnv } from "@/components/record/editors/env";
import { FieldDialog, type FieldDialogState } from "@/components/fields/FieldDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Icon } from "@/components/ui/icon";
import { PropertyList, PropertyRow } from "@/components/ui/property-list";
import { useToast } from "@/components/ui/toast";
import { jsonEqual } from "@/lib/cells/parse";
import { isComputed, isMultilineText } from "@/lib/cells/kinds";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { ActionMenu, MenuItem, MenuSeparator } from "@/shell/menuItems";
import { foldLabel, hasValue, splitProperties, type TitleMode } from "./properties";
import { useRecordFolds, type FoldKind } from "./useRecordFolds";
import type { RecordLayout } from "./useRecordLayout";
import type { RecordSave, Unsent } from "./useRecordSave";

/** What a property's name is: plain text, or the button that opens its menu. */
function PropertyName({ field, id, role, hidden, layout, onRename, onEdit, onDelete }: { field: Field; id: string; role: string; hidden: boolean; layout: RecordLayout | null; onRename(): void; onEdit(): void; onDelete(): void }) {
  const creator = atLeast(role, "creator");
  const editor = !!layout && atLeast(role, "editor");
  const box = "flex min-h-9 items-center truncate max-md:min-h-control-touch";
  if (!creator && !editor) {
    return (
      <span id={id} className={box} title={field.description ?? undefined}>
        <span className="truncate">{field.name}</span>
      </span>
    );
  }
  return (
    <ActionMenu
      title={field.name}
      trigger={
        <button id={id} type="button" title={field.description ?? undefined} className={cn(box, "-mx-1.5 w-[calc(100%+0.75rem)] rounded-md px-1.5 text-left hover:bg-hover hover:text-fg")}>
          <span className="truncate">{field.name}</span>
        </button>
      }
    >
      {creator && (
        <>
          <MenuItem icon={Pencil} onSelect={onRename}>
            Rename
          </MenuItem>
          <MenuItem icon={SlidersHorizontal} onSelect={onEdit}>
            Edit property
          </MenuItem>
        </>
      )}
      {editor && (
        <MenuItem icon={hidden ? Eye : EyeOff} onSelect={() => layout.setHidden(field.id, !hidden)}>
          {hidden ? "Show on pages" : "Hide from pages"}
        </MenuItem>
      )}
      {creator && (
        <>
          <MenuSeparator />
          <MenuItem icon={Trash2} danger onSelect={onDelete}>
            Delete property
          </MenuItem>
        </>
      )}
    </ActionMenu>
  );
}

interface RowProps {
  field: Field;
  record: TableRecord;
  readOnly: boolean;
  hidden: boolean;
  role: string;
  error?: string;
  env: EditorEnv;
  emails: ReadonlyMap<string, string>;
  lastSaved: RefObject<Map<string, unknown>>;
  /** Which multiline text properties have text of ours that is typed but not sent yet, or sent and not answered yet. */
  unsent: RefObject<Unsent>;
  /** The value of this property that could not be saved, kept for the person to correct. */
  failed?: { value: unknown };
  /** The property starts being edited (the title of a record just added, when it is a row). */
  startEditing: boolean;
  layout: RecordLayout | null;
  onSave: (field: Field, edit: EditValue) => { value: unknown } | undefined;
  onRename(field: Field): void;
  onEdit(field: Field): void;
  onDelete(field: Field): void;
}

function PropertyEntry({ field, record, readOnly, hidden, role, error, env, emails, lastSaved, unsent, failed, startEditing, layout, onSave, onRename, onEdit, onDelete }: RowProps) {
  const value = record.values[field.id] ?? null;
  const computed = isComputed(field);
  const labelId = `property-${field.id}`;
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
    <PropertyRow label={<PropertyName field={field} id={labelId} role={role} hidden={hidden} layout={layout} onRename={() => onRename(field)} onEdit={() => onEdit(field)} onDelete={() => onDelete(field)} />} className="items-start">
      {readOnly || computed ? (
        <div className="flex min-h-9 flex-col justify-center rounded-md px-2 py-1 max-md:min-h-control-touch">
          <CellValue field={field} value={value} format={env.format} emails={emails} linkFiles />
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
    </PropertyRow>
  );
}

function Fold({ kind, count, open, controls, onToggle }: { kind: FoldKind; count: number; open: boolean; controls: string; onToggle(): void }) {
  return (
    <button type="button" aria-expanded={open} aria-controls={controls} onClick={onToggle} className="mt-1 flex min-h-9 items-center gap-1 rounded-md text-label font-medium text-muted hover:text-fg max-md:min-h-control-touch">
      <Icon icon={ChevronDown} size="sm" className={cn("transition-transform", !open && "-rotate-90")} />
      {foldLabel(kind, count, open)}
    </button>
  );
}

export interface RecordPropertiesProps {
  schema: BaseSchema;
  table: Table;
  record: TableRecord;
  /** The collection's default view: its layout is every record's. */
  view: View | null;
  role: string;
  env: EditorEnv;
  emails: ReadonlyMap<string, string>;
  save: RecordSave;
  layout: RecordLayout;
  titleMode: TitleMode;
  /** The record was just added: a title that is a row starts being edited. */
  justCreated: boolean;
}

export function RecordProperties({ schema, table, record, view, role, env, emails, save, layout, titleMode, justCreated }: RecordPropertiesProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const readOnly = !atLeast(role, "editor");
  const [folds, toggleFold] = useRecordFolds(table.id);
  const [dialog, setDialog] = useState<FieldDialogState | null>(null);
  const [deleting, setDeleting] = useState<Field | null>(null);

  // Properties that had a value when the page opened keep their row if they are cleared: it does not move
  // from under the cursor (and the focus the editor hands back to it).
  const pinned = useRef({ recordId: record.id, ids: new Set<string>() });
  if (pinned.current.recordId !== record.id) pinned.current = { recordId: record.id, ids: new Set() };
  for (const f of table.fields) if (hasValue(f, record.values[f.id])) pinned.current.ids.add(f.id);

  const groups = useMemo(
    () => splitProperties({ table, layout: view?.config, values: record.values, title: titleMode, pinned: pinned.current.ids }),
    // The pinned set grows in render, with `record.values`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table, view?.config, record.values, titleMode],
  );

  const remove = useCallback(
    async (field: Field) => {
      await schemaApi.deleteField(field.id);
      void qc.invalidateQueries({ queryKey: keys.base(schema.id) });
      void qc.invalidateQueries({ queryKey: ["records"] });
      toast.toast({ title: `Property “${field.name}” deleted`, description: "It is in the trash for a while.", variant: "success" });
    },
    [qc, schema.id, toast],
  );

  const row = (f: Field, hidden: boolean) => (
    <PropertyEntry
      key={f.id}
      field={f}
      record={record}
      readOnly={readOnly}
      hidden={hidden}
      role={role}
      error={save.errors[f.id]}
      failed={save.failed[f.id]}
      startEditing={justCreated && f.id === table.primary_field_id}
      env={env}
      emails={emails}
      lastSaved={save.lastSaved}
      unsent={save.unsent}
      layout={view ? layout : null}
      onSave={save.onSave}
      onRename={(field) => setDialog({ mode: "edit", field, focus: "name" })}
      onEdit={(field) => setDialog({ mode: "edit", field })}
      onDelete={setDeleting}
    />
  );

  const emptyId = `empty-${record.id}`;
  const hiddenId = `hidden-${record.id}`;
  return (
    <section aria-label="Properties">
      {groups.shown.length > 0 && <PropertyList>{groups.shown.map((f) => row(f, false))}</PropertyList>}
      {groups.empty.length > 0 && (
        <>
          <Fold kind="empty" count={groups.empty.length} open={folds.empty} controls={emptyId} onToggle={() => toggleFold("empty")} />
          {folds.empty && <PropertyList id={emptyId}>{groups.empty.map((f) => row(f, false))}</PropertyList>}
        </>
      )}
      {groups.hidden.length > 0 && (
        <>
          <Fold kind="hidden" count={groups.hidden.length} open={folds.hidden} controls={hiddenId} onToggle={() => toggleFold("hidden")} />
          {folds.hidden && <PropertyList id={hiddenId}>{groups.hidden.map((f) => row(f, true))}</PropertyList>}
        </>
      )}
      {dialog && <FieldDialog state={dialog} schema={schema} table={table} onOpenChange={(open) => !open && setDialog(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete property “${deleting?.name ?? ""}”?`}
        description="The property and its values are removed from every view and every record. You can bring it back from the trash."
        confirmLabel="Delete property"
        destructive
        onConfirm={async () => {
          if (deleting) await remove(deleting);
        }}
      />
    </section>
  );
}
