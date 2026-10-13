/**
 * The builder's field list: drag to reorder (dnd-kit; pointer and keyboard, with up/down buttons
 * as a plain alternative), a label override, help text and a required switch per field, remove,
 * and a picker to add the fields that are not in the form yet.
 */
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical, Lock, Plus, X } from "lucide-react";
import type { Field, FormConfig, FormField, Table } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Select, Textarea } from "@/components/ui/input";
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
  const status = publicStatus(field, hiddenFields);
  const patch = (p: FormFieldPatch) => onChange(updateFormField(form, field.id, p));
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-field-id={field.id}
      aria-label={`Form field ${field.name}`}
      className={cn("rounded-md border border-line bg-surface", isDragging && "relative z-10 opacity-80 shadow-pop")}
    >
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
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
        <span className="min-w-0 flex-1 basis-24 truncate text-[0.8125rem] font-medium">{field.name}</span>
        {!status.public && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs" title={status.message}>
            <Lock aria-hidden className="size-3" /> Not on the public form
          </span>
        )}
        <Switch checked={entry.required} disabled={readOnly} onCheckedChange={(required) => patch({ required })} label="Required" />
        <IconButton label={`Move ${field.name} up`} size="sm" noTooltip disabled={readOnly || index === 0} onClick={() => onChange(moveFormField(form, index, index - 1))}>
          <ArrowUp aria-hidden className="size-4" />
        </IconButton>
        <IconButton label={`Move ${field.name} down`} size="sm" noTooltip disabled={readOnly || index === count - 1} onClick={() => onChange(moveFormField(form, index, index + 1))}>
          <ArrowDown aria-hidden className="size-4" />
        </IconButton>
        <IconButton label={`Remove ${field.name} from the form`} size="sm" noTooltip disabled={readOnly} onClick={() => onChange(removeFormField(form, field.id))}>
          <X aria-hidden className="size-4" />
        </IconButton>
      </div>
      <div className="grid gap-2 border-t border-line px-3 py-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Label
          <Input aria-label={`Label for ${field.name}`} value={entry.label ?? ""} placeholder={field.name} maxLength={255} disabled={readOnly} onChange={(e) => patch({ label: e.target.value })} className="text-[0.8125rem] text-fg" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Help text
          <Textarea aria-label={`Help text for ${field.name}`} rows={1} value={entry.help ?? ""} placeholder="Shown under the label" maxLength={MAX_FORM_TEXT} disabled={readOnly} onChange={(e) => patch({ help: e.target.value })} className="min-h-8 text-[0.8125rem] text-fg" />
        </label>
      </div>
      {!status.public && <p className="border-t border-line px-3 py-1.5 text-xs text-muted">{status.message}</p>}
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
    <section aria-labelledby="form-fields-heading" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="form-fields-heading" className="text-[0.9375rem]">
          Fields
        </h3>
        <span className="text-xs text-muted">
          {entries.length} in the form{computedCount > 0 ? `, ${computedCount} computed field${computedCount === 1 ? "" : "s"} cannot be asked` : ""}
        </span>
      </div>
      {entries.length === 0 && <p className="rounded-md border border-dashed border-line-strong px-3 py-4 text-center text-[0.8125rem] text-muted">No fields yet. Add the fields this form should ask for.</p>}
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
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <div className="w-52">
            <Select
              aria-label="Add a field to the form"
              value=""
              disabled={addable.length === 0}
              onChange={(e) => {
                if (e.target.value) onChange(addFormField(form, table, e.target.value));
              }}
            >
              <option value="">{addable.length === 0 ? "All fields added" : "Add a field…"}</option>
              {addable.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" disabled={addable.length === 0} onClick={() => onChange(addAllFormFields(form, table))}>
            <Plus aria-hidden className="size-4" /> Add all fields
          </Button>
        </div>
      )}
    </section>
  );
}
