/**
 * The builder's field list: one compact row per field with a drag handle (dnd-kit; pointer and
 * keyboard), its type, its name, a required switch and remove. The name opens the row to change the
 * label and help text, with up/down buttons as a plain alternative to dragging. "Add a field" lists
 * the fields that are not in the form yet.
 */
import { useState } from "react";
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
import { cn } from "@/lib/cn";
import { MAX_FORM_TEXT, addAllFormFields, canBeInForm, addFormField, addableFields, liveEntries, moveFormField, moveFormFieldById, publicStatus, removeFormField, updateFormField, type FormFieldPatch } from "@/lib/forms/formConfig";

export interface FormFieldListProps {
  form: FormConfig;
  table: Pick<Table, "fields">;
  hiddenFields: readonly string[];
  readOnly: boolean;
  onChange: (next: FormConfig) => void;
}

function Row({ entry, field, index, count, hiddenFields, readOnly, onChange, form }: { entry: FormField; field: Field; index: number; count: number; hiddenFields: readonly string[]; readOnly: boolean; onChange: FormFieldListProps["onChange"]; form: FormConfig }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id, disabled: readOnly });
  // A field whose label or help was changed shows those straight away, so the change is not hidden.
  const [open, setOpen] = useState(() => !!(entry.label?.trim() || entry.help?.trim()));
  const status = publicStatus(field, hiddenFields);
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
      <div className="flex min-h-[46px] flex-wrap items-center gap-2.5 px-1.5">
        <button
          type="button"
          aria-label={`Drag ${field.name} to reorder`}
          disabled={readOnly}
          className="inline-flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-faint hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-40"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
        <FieldTypeIcon type={field.type} />
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Edit ${field.name}`}
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 basis-24 truncate rounded text-left text-[0.875rem] font-medium hover:underline"
          title="Change the label and help text"
        >
          {shownName}
        </button>
        {!status.public && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs" title={status.message}>
            <Lock aria-hidden className="size-3" /> Not public
          </span>
        )}
        <Switch className="flex-row-reverse text-muted" checked={entry.required} disabled={readOnly} onCheckedChange={(required) => patch({ required })} label="Required" />
        <IconButton label={`Remove ${field.name} from the form`} size="sm" noTooltip disabled={readOnly} onClick={() => onChange(removeFormField(form, field.id))}>
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
        </div>
      )}
    </li>
  );
}

export function FormFieldList({ form, table, hiddenFields, readOnly, onChange }: FormFieldListProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const entries = liveEntries(form, table);
  const ids = entries.map((e) => e.field.id);
  const addable = addableFields(form, table);
  const computedCount = table.fields.filter((f) => !canBeInForm(f)).length;

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
              <Row key={field.id} entry={entry} field={field} index={i} count={entries.length} hiddenFields={hiddenFields} readOnly={readOnly} form={form} onChange={onChange} />
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
          <DropdownMenuContent align="start" className="max-h-80 w-60 overflow-y-auto">
            {addable.map((f) => (
              <DropdownMenuItem key={f.id} onSelect={() => onChange(addFormField(form, table, f.id))}>
                <FieldTypeIcon type={f.type} /> {f.name}
              </DropdownMenuItem>
            ))}
            {addable.length > 1 && (
              <DropdownMenuItem onSelect={() => onChange(addAllFormFields(form, table))}>
                <ListPlus aria-hidden className="size-4 text-muted" /> Add all fields
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </section>
  );
}
