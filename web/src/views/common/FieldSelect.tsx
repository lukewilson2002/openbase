/** A select over a layout's fields, used in View options (the layout's own settings and the Properties screen). */
import type { ReactNode } from "react";
import type { Field } from "@/api/types";
import { Field as FormField, Select } from "@/components/ui/input";

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
              Choose a property
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
