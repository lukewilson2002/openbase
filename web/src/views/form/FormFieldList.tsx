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
 *
 * Headings and paragraphs sit between the fields in the same list (they are dragged, moved and removed the same
 * way, with their text edited in the row), and any row can be shown only when the answers above it match
 * ("Show only if", the filter builder over the questions above the row).
 */
import { useRef, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlignLeft, ArrowDown, ArrowUp, GitBranch, GripVertical, Heading, ListPlus, Lock, Plus, X } from "lucide-react";
import type { Field, FormBlock, FormConfig, FormField, Table } from "@/api/types";
import { FilterBuilder } from "@/components/viewbar/FilterBuilder";
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
  addFormBlock,
  blockText,
  canBeInForm,
  cleanForm,
  addFormField,
  addableFields,
  liveItems,
  moveFormField,
  moveFormFieldById,
  pruneForm,
  publicStatus,
  removeFormField,
  removedFormField,
  requiredBlockedReason,
  sameForm,
  showIfSources,
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
  onRemove: (id: string, name: string) => void;
  onShowPublic?: FormFieldListProps["onShowPublic"];
  form: FormConfig;
  table: Pick<Table, "fields">;
}

/** Marks a row that is shown only for some answers; on a phone only the icon fits next to the row's controls. */
function ConditionalBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full bg-subtle px-2 py-0.5 text-xs text-muted", className)} title="Shown only when the answers above match">
      <GitBranch aria-hidden className="size-3" /> <span className="max-sm:sr-only">Conditional</span>
    </span>
  );
}

/** "Show only if": the filter builder over the questions above the row; nothing set means the row is always shown. */
function ShowIfEditor({ form, table, entry, name, readOnly, onChange }: { form: FormConfig; table: Pick<Table, "fields">; entry: FormField; name: string; readOnly: boolean; onChange: (showIf: FormField["show_if"]) => void }) {
  const place = form.fields.findIndex((f) => f.field_id === entry.field_id);
  const sources = showIfSources(form, table, place);
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-2" data-testid={`show-if-${entry.field_id}`}>
      <p className="text-xs font-medium text-muted">Show only if</p>
      {sources.length === 0 && !entry.show_if ? (
        <p className="text-xs text-muted">Put a text, number, rating, checkbox or select question above this one to show it only for some answers.</p>
      ) : (
        <FilterBuilder value={entry.show_if ?? null} onChange={onChange} fields={sources} collaborators={[]} readOnly={readOnly} emptyText="Always shown. Add a condition to show it only for some answers above." label={`Show ${name} only if`} />
      )}
    </div>
  );
}

function Row({ entry, field, index, count, hiddenFields, readOnly, onChange, onRemove, onShowPublic, form, table }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id, disabled: readOnly });
  // A field whose label or help was changed shows those straight away, so the change is not hidden.
  const [open, setOpen] = useState(() => !!(entry.label?.trim() || entry.help?.trim() || entry.show_if));
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
      {/* On a narrow screen the switch and remove button drop to a second line instead of squeezing the name out. */}
      <div className="flex min-h-[46px] flex-wrap items-center gap-x-2.5 gap-y-1 px-1.5 py-0.5 pointer-coarse:min-h-[56px]">
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
          className="min-w-20 flex-1 truncate rounded text-left text-[0.875rem] font-medium hover:underline"
          title="Change the label, help text and conditions"
        >
          {shownName}
        </button>
        {entry.show_if && <ConditionalBadge />}
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
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
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
          <IconButton label={`Remove ${field.name} from the form`} size="sm" noTooltip disabled={readOnly} className="pointer-coarse:ml-2" onClick={() => onRemove(field.id, field.name)}>
            <X aria-hidden className="size-4" />
          </IconButton>
        </div>
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
              <Textarea
                aria-label={`Help text for ${field.name}`}
                rows={1}
                value={entry.help ?? ""}
                placeholder={field.description?.trim() || "Shown under the label"}
                maxLength={MAX_FORM_TEXT}
                disabled={readOnly}
                onChange={(e) => patch({ help: e.target.value })}
                className="min-h-8 text-[0.8125rem] text-fg"
              />
              {field.description?.trim() && !entry.help?.trim() && <span>The field's description is shown while this is empty.</span>}
            </label>
          </div>
          <MoveButtons name={field.name} index={index} count={count} readOnly={readOnly} form={form} onChange={onChange} />
          <ShowIfEditor form={form} table={table} entry={entry} name={field.name} readOnly={readOnly} onChange={(show_if) => patch({ show_if })} />
          {!status.public && <p className="text-xs text-muted">{status.message}</p>}
          {noRequired && <p className="text-xs text-muted">{noRequired}</p>}
        </div>
      )}
    </li>
  );
}

function MoveButtons({ name, index, count, readOnly, form, onChange }: { name: string; index: number; count: number; readOnly: boolean; form: FormConfig; onChange: (next: FormConfig) => void }) {
  return (
    <div className="flex items-center gap-1 text-xs text-muted">
      <span className="mr-1">Order</span>
      <IconButton label={`Move ${name} up`} size="sm" noTooltip disabled={readOnly || index === 0} onClick={() => onChange(moveFormField(form, index, index - 1))}>
        <ArrowUp aria-hidden className="size-4" />
      </IconButton>
      <IconButton label={`Move ${name} down`} size="sm" noTooltip disabled={readOnly || index === count - 1} onClick={() => onChange(moveFormField(form, index, index + 1))}>
        <ArrowDown aria-hidden className="size-4" />
      </IconButton>
    </div>
  );
}

const BLOCK_LABEL: Record<FormBlock, string> = { heading: "Heading", text: "Text" };

/** A heading or a paragraph: its text is edited right in the row. */
function BlockRow({ entry, index, count, readOnly, onChange, onRemove, form, table }: Omit<RowProps, "field" | "hiddenFields" | "onShowPublic"> & { entry: FormField & { block: FormBlock } }) {
  const id = entry.field_id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: readOnly });
  const kind = BLOCK_LABEL[entry.block];
  const name = blockText(entry) || `Empty ${kind.toLowerCase()}`;
  const patch = (p: FormFieldPatch) => onChange(updateFormField(form, id, p));
  const Icon = entry.block === "heading" ? Heading : AlignLeft;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-field-id={id}
      aria-label={`${kind} ${name}`}
      className={cn("rounded-[10px] border border-dashed border-line-strong bg-surface", isDragging && "relative z-10 opacity-80 shadow-pop")}
    >
      <div className="flex items-start gap-2.5 px-1.5 py-1.5">
        <button
          type="button"
          aria-label={`Drag the ${kind.toLowerCase()} ${name} to reorder`}
          disabled={readOnly}
          className="mt-0.5 inline-flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-faint hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-40 pointer-coarse:mr-1 pointer-coarse:size-11"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden className="size-4 pointer-coarse:size-5" />
        </button>
        <span className="mt-2 inline-flex shrink-0 text-muted" title={kind}>
          <Icon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          {entry.block === "heading" ? (
            <Input aria-label={`Heading text`} value={entry.label ?? ""} placeholder="Heading" maxLength={255} disabled={readOnly} onChange={(e) => patch({ label: e.target.value })} className="text-[0.9375rem] font-semibold" />
          ) : (
            <Textarea aria-label={`Text`} rows={2} value={entry.help ?? ""} placeholder="Some words for the people filling this in" maxLength={MAX_FORM_TEXT} disabled={readOnly} onChange={(e) => patch({ help: e.target.value })} className="text-[0.8125rem]" />
          )}
        </div>
        {entry.show_if && <ConditionalBadge className="mt-1.5" />}
        <IconButton label={`Remove the ${kind.toLowerCase()} ${name} from the form`} size="sm" noTooltip disabled={readOnly} className="mt-0.5 pointer-coarse:ml-2" onClick={() => onRemove(id, `${kind} “${name}”`)}>
          <X aria-hidden className="size-4" />
        </IconButton>
      </div>
      <div className="flex flex-col gap-2 border-t border-line px-3 py-2">
        <MoveButtons name={`the ${kind.toLowerCase()} ${name}`} index={index} count={count} readOnly={readOnly} form={form} onChange={onChange} />
        <ShowIfEditor form={form} table={table} entry={entry} name={`the ${kind.toLowerCase()} ${name}`} readOnly={readOnly} onChange={(show_if) => patch({ show_if })} />
      </div>
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
  const items = liveItems(form, table);
  const ids = items.map((i) => i.entry.field_id);
  const addable = addableFields(form, table);
  const questions = items.filter((i) => i.kind === "field").length;
  const computedCount = table.fields.filter((f) => !canBeInForm(f)).length;
  const at = (id: string) => form.fields.findIndex((f) => f.field_id === id);

  const onRemove = (id: string, name: string) => {
    const taken = removedFormField(form, id);
    if (!taken) return;
    removed.current.set(id, taken);
    const removedForm = removeFormField(form, id);
    onChange(removedForm);
    // What the form is saved as once the removal went through (conditions on the removed question are dropped with it).
    const saved = cleanForm(pruneForm(removedForm, table));
    toast.toast({
      title: `${name} removed from the form`,
      // A field goes back through addFormField (which knows the table); a heading or paragraph is put back as it was.
      action: {
        label: "Undo",
        onClick: () => {
          const cur = latest.current;
          // Nothing changed since: bring the form back exactly as it was, with the conditions that read the question.
          if (sameForm(cur, saved)) onChange(form);
          else if (taken.entry.block) {
            const fields = [...cur.fields];
            fields.splice(Math.min(taken.index, fields.length), 0, taken.entry);
            onChange({ ...cur, fields });
          } else onChange(addFormField(cur, table, id, taken));
        },
      },
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
          {questions} in the form{computedCount > 0 ? `, ${computedCount} computed field${computedCount === 1 ? "" : "s"} cannot be asked` : ""}
        </span>
      </div>
      {items.length === 0 && <p className="rounded-[10px] border border-dashed border-line-strong px-3 py-4 text-center text-[0.8125rem] text-muted">No fields yet. Add the fields this form should ask for.</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul aria-label="Form fields" className="flex flex-col gap-2">
            {items.map((item) =>
              item.kind === "field" ? (
                <Row
                  key={item.field.id}
                  entry={item.entry}
                  field={item.field}
                  index={at(item.field.id)}
                  count={form.fields.length}
                  hiddenFields={hiddenFields}
                  readOnly={readOnly}
                  form={form}
                  table={table}
                  onChange={onChange}
                  onRemove={onRemove}
                  onShowPublic={onShowPublic}
                />
              ) : (
                <BlockRow key={item.entry.field_id} entry={item.entry as FormField & { block: FormBlock }} index={at(item.entry.field_id)} count={form.fields.length} readOnly={readOnly} form={form} table={table} onChange={onChange} onRemove={onRemove} />
              ),
            )}
          </ul>
        </SortableContext>
      </DndContext>
      {!readOnly && (
        <div className="flex flex-wrap gap-x-1">
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="flex h-9 items-center gap-1.5 self-start rounded-lg px-2.5 text-[0.875rem] text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover">
                <Heading aria-hidden className="size-[15px]" /> Add a heading or text
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuItem onSelect={() => onChange(addFormBlock(form, "heading"))}>
                <Heading aria-hidden className="size-4 text-muted" /> Section heading
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onChange(addFormBlock(form, "text"))}>
                <AlignLeft aria-hidden className="size-4 text-muted" /> Text between fields
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </section>
  );
}
