/** Toolbar control for view-type specific settings (stack field, date fields, scale...). */
import type { ReactNode } from "react";
import type { Field } from "@/api/types";
import { Field as FormField, Select } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toolButtonClass } from "@/components/viewbar/ViewBar";

/**
 * The view's own setting as a toolbar tool. Worded like the other tools and tinted once it is set
 * ("Stacked by How often"), the way "Sorted by Who" is; in the phone's tools menu it sits under them.
 */
export function ViewSettings({ label = "Settings", active, note, children }: { label?: string; active?: boolean; note?: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={toolButtonClass(active)}>
          {label}
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
