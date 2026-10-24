/**
 * The builder's field list: one compact row per field with a drag handle (dnd-kit; pointer and
 * keyboard), its type, its name, a required switch and remove. The name opens the row to change the
 * label and help text, with up/down buttons as a plain alternative to dragging. "Add a field" lists
 * the fields that are not in the form yet. A removed field keeps its label, help text and required
 * switch for as long as the builder is open: a toast offers Undo, and adding it again puts it back
 * where it was, as it was.
 *
 * Link and user fields cannot be required (the public form does not collect them), and a field the form
 * view hides can be shown on the public form again from its row.
 */
import { useRef, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical, ListPlus, Lock, Plus, X } from "lucide-react";
import type { Field, FormConfig, FormField, Table } from "@/api/types";
import { Switch } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import {
  MAX_FORM_TEXT,
  addAllFormFields,
  canBeInForm,
  addFormField,
  addableFields,
  liveEntries,
  moveFormField,
  moveFormFieldById,
  publicStatus,
  removeFormField,
  removedFormField,
  requiredBlockedReason,
  updateFormField,
  type FormFieldPatch,
  type RemovedFormField,
} from "@/lib/forms/formConfig";

export interface FormFieldListProps {
  form: FormConfig;
  table: Pick<Table, "fields">;
  hiddenFields: readonly string[];
  readOnly: boolean;
  onChange: (next: FormConfig) => void;
  /** Shows a field the form view hides on the public form again. */
  onShowPublic?: (fieldId: string) => void;
}

interface RowProps {
  entry: FormField;
  field: Field;
  index: number;
  count: number;
  hiddenFields: readonly string[];
  readOnly: boolean;
  onChange: FormFieldListProps["onChange"];
  onRemove: (field: Field) => void;
  onShowPublic?: FormFieldListProps["onShowPublic"];
  form: FormConfig;
}

function Row({ entry, field, index, count, hiddenFields, readOnly, onChange, onRemove, onShowPublic, form }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id, disabled: readOnly });
  // A field whose label or help was changed shows those straight away, so the change is not hidden.
  const [open, setOpen] = useState(() => !!(entry.label?.trim() || entry.help?.trim()));
  const status = publicStatus(field, hiddenFields);
  // A field the public form cannot ask for cannot be required either; one that already is can still be switched off.
  const noRequired = requiredBlockedReason(field);
  const requiredLocked = noRequired !== null && !entry.required;
  const patch = (p: FormFieldPatch) => onChange(updateFormField(form, field.id, p));
  const shownName = entry.label?.trim() || field.name;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-field-id={field.id}
      aria-label={`Form field ${field.name}`}
      className={cn("rounded-[10px] border border-line bg-surface", isDragging && "relative z-10 opacity-80 shadow-pop")}
    >
      <div className="flex min-h-[46px] items-center gap-2.5 px-1.5 pointer-coarse:min-h-[56px]">
        <button
          type="button"
          aria-label={`Drag ${field.name} to reorder`}
          disabled={readOnly}
          className="inline-flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-faint hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-40 pointer-coarse:mr-1 pointer-coarse:size-11"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden className="size-4 pointer-coarse:size-5" />
        </button>
        <FieldTypeIcon type={field.type} />
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Edit ${field.name}`}
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 truncate rounded text-left text-[0.875rem] font-medium hover:underline"
          title="Change the label and help text"
        >
          {shownName}
        </button>
        {!status.public && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs" title={status.message}>
            <Lock aria-hidden className="size-3" /> <span className="max-sm:sr-only">Not public</span>
          </span>
        )}
        {status.public === false && status.reason === "hidden" && onShowPublic && !readOnly && (
          <button
            type="button"
            aria-label={`Show ${field.name} on the public form`}
            title="Show this field on the public form"
            onClick={() => onShowPublic(field.id)}
            className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-primary-text hover:bg-hover pointer-coarse:py-2"
          >
            Show
          </button>
        )}
        <span title={noRequired ?? undefined} className="shrink-0">
          <Switch
            className="flex-row-reverse text-muted"
            checked={entry.required}
            disabled={readOnly || requiredLocked}
            onCheckedChange={(required) => patch({ required })}
            label={
              <>
                Required
                {requiredLocked && <span className="sr-only"> ({noRequired})</span>}
              </>
            }
          />
        </span>
        <IconButton label={`Remove ${field.name} from the form`} size="sm" noTooltip disabled={readOnly} className="pointer-coarse:ml-2" onClick={() => onRemove(field)}>
          <X aria-hidden className="size-4" />
        </IconButton>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line px-3 py-2.5">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Label
              <Input aria-label={`Label for ${field.name}`} value={entry.label ?? ""} placeholder={field.name} maxLength={255} disabled={readOnly} onChange={(e) => patch({ label: e.target.value })} className="text-[0.8125rem] text-fg" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Help text
              <Textarea aria-label={`Help text for ${field.name}`} rows={1} value={entry.help ?? ""} placeholder="Shown under the label" maxLength={MAX_FORM_TEXT} disabled={readOnly} onChange={(e) => patch({ help: e.target.value })} className="min-h-8 text-[0.8125rem] text-fg" />
            </label>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted">
            <span className="mr-1">Order</span>
            <IconButton label={`Move ${field.name} up`} size="sm" noTooltip disabled={readOnly || index === 0} onClick={() => onChange(moveFormField(form, index, index - 1))}>
              <ArrowUp aria-hidden className="size-4" />
            </IconButton>
            <IconButton label={`Move ${field.name} down`} size="sm" noTooltip disabled={readOnly || index === count - 1} onClick={() => onChange(moveFormField(form, index, index + 1))}>
              <ArrowDown aria-hidden className="size-4" />
            </IconButton>
          </div>
          {!status.public && <p className="text-xs text-muted">{status.message}</p>}
          {noRequired && <p className="text-xs text-muted">{noRequired}</p>}
        </div>
      )}
    </li>
  );
}

export function FormFieldList({ form, table, hiddenFields, readOnly, onChange, onShowPublic }: FormFieldListProps) {
  const toast = useToast();
  // What was removed, by field id, for putting it back where it was with its label, help text and required switch.
  const removed = useRef(new Map<string, RemovedFormField>());
  const latest = useRef(form);
  latest.current = form;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const entries = liveEntries(form, table);
  const ids = entries.map((e) => e.field.id);
  const addable = addableFields(form, table);
  const computedCount = table.fields.filter((f) => !canBeInForm(f)).length;

  const onRemove = (field: Field) => {
    const taken = removedFormField(form, field.id);
    if (!taken) return;
    removed.current.set(field.id, taken);
    onChange(removeFormField(form, field.id));
    toast.toast({
      title: `${field.name} removed from the form`,
      action: { label: "Undo", onClick: () => onChange(addFormField(latest.current, table, field.id, taken)) },
      durationMs: 8000,
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) onChange(moveFormFieldById(form, String(e.active.id), String(e.over.id)));
  };

  return (
    <section aria-labelledby="form-fields-heading" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="form-fields-heading" className="text-[0.9375rem] font-bold">
          Fields
        </h3>
        <span className="text-[0.8125rem] text-muted">
          {entries.length} in the form{computedCount > 0 ? `, ${computedCount} computed field${computedCount === 1 ? "" : "s"} cannot be asked` : ""}
        </span>
      </div>
      {entries.length === 0 && <p className="rounded-[10px] border border-dashed border-line-strong px-3 py-4 text-center text-[0.8125rem] text-muted">No fields yet. Add the fields this form should ask for.</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul aria-label="Form fields" className="flex flex-col gap-2">
            {entries.map(({ entry, field }, i) => (
              <Row key={field.id} entry={entry} field={field} index={i} count={entries.length} hiddenFields={hiddenFields} readOnly={readOnly} form={form} onChange={onChange} onRemove={onRemove} onShowPublic={onShowPublic} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {!readOnly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={addable.length === 0}
              className="-ml-1 flex h-9 items-center gap-1.5 self-start rounded-lg px-2.5 text-[0.875rem] text-muted hover:bg-hover hover:text-fg disabled:opacity-50 data-[state=open]:bg-hover"
            >
              <Plus aria-hidden className="size-[15px]" /> {addable.length === 0 ? "All fields are in the form" : "Add a field"}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[min(20rem,var(--ob-avail))] w-60 overflow-y-auto">
            {addable.map((f) => (
              <DropdownMenuItem key={f.id} onSelect={() => onChange(addFormField(form, table, f.id, removed.current.get(f.id)))}>
                <FieldTypeIcon type={f.type} /> {f.name}
              </DropdownMenuItem>
            ))}
            {addable.length > 1 && (
              <DropdownMenuItem onSelect={() => onChange(addAllFormFields(form, table, removed.current))}>
                <ListPlus aria-hidden className="size-4 text-muted" /> Add all fields
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </section>
  );
}
