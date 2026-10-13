/** Toolbar control for view-type specific settings (stack field, date fields, scale...). */
import type { ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { Field } from "@/api/types";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { Field as FormField, Select } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function ViewSettings({ label = "Settings", note, children }: { label?: string; note?: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[0.8125rem] font-medium text-fg hover:bg-hover">
          <SlidersHorizontal aria-hidden className="size-4" />
          <span className="hidden sm:inline">{label}</span>
          <span className="sr-only sm:hidden">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-[min(34rem,80dvh)] w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-3 overflow-y-auto p-3">
        {note && <p className="rounded bg-warning-soft px-2 py-1 text-xs">{note}</p>}
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** A select over fields. `value` is a field id or "" for none. */
export function FieldSelect({
  label,
  fields,
  value,
  onChange,
  noneLabel,
  disabled,
  hint,
}: {
  label: string;
  fields: readonly Field[];
  value: string;
  onChange: (fieldId: string | null) => void;
  /** Label of the empty choice; omit to require a field. */
  noneLabel?: string;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <FormField label={label} hint={hint}>
      {(ctl) => (
        <Select {...ctl} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
          {noneLabel !== undefined && <option value="">{noneLabel}</option>}
          {value === "" && noneLabel === undefined && (
            <option value="" disabled>
              Choose a field
            </option>
          )}
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      )}
    </FormField>
  );
}

/** Small field name with its type icon (for lists in pickers). */
export function FieldLabel({ field }: { field: Field }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <FieldTypeIcon type={field.type} /> {field.name}
    </span>
  );
}

/** Shown in place of a view that needs a field choice first. */
export function SetupPrompt({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-pop">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-[0.8125rem] text-muted">{description}</p>
        {children}
      </div>
    </div>
  );
}
