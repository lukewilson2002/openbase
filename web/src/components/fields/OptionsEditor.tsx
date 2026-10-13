/** Type-specific options for the field dialog: one editor per field type (28), all controlled. */
import { useMemo } from "react";
import type { DateFormat, DateOptions, DurationFormat, Field, FieldKind, TimeFormat, ValueFormat } from "@/api/types";
import { Checkbox } from "@/components/ui/checkbox";
import { EntitySelect } from "@/components/ui/entity-select";
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import { Field as FormField, Input, Select } from "@/components/ui/input";
import { listTimeZones } from "@/lib/format";
import { FormulaEditor } from "./FormulaEditor";
import { SelectChoicesEditor } from "./SelectChoicesEditor";
import { linkFields, type KindContext } from "./fieldKinds";

export interface OptionsEditorProps {
  kind: FieldKind;
  onChange: (kind: FieldKind) => void;
  ctx: KindContext;
  /** The field being edited (excluded from its own formula references), if any. */
  existing?: Field;
  /** Link fields: name of the inverse field (create only). */
  inverseName: string;
  onInverseName: (name: string) => void;
  creating: boolean;
}

const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: "us", label: "US (10/12/2026)" },
  { value: "european", label: "European (12/10/2026)" },
  { value: "iso", label: "ISO (2026-10-12)" },
  { value: "friendly", label: "Friendly (October 12, 2026)" },
];

const DURATION_FORMATS: { value: DurationFormat; label: string }[] = [
  { value: "h_mm", label: "h:mm" },
  { value: "h_mm_ss", label: "h:mm:ss" },
  { value: "h_mm_ss_s", label: "h:mm:ss.s" },
  { value: "h_mm_ss_ss", label: "h:mm:ss.ss" },
  { value: "h_mm_ss_sss", label: "h:mm:ss.sss" },
];

const CURRENCY_SYMBOLS = ["$", "€", "£", "¥", "₹", "CHF", "kr", "R$"];

const ROLLUP_PRESETS: { label: string; expression: string }[] = [
  { label: "Sum", expression: "SUM(values)" },
  { label: "Average", expression: "AVERAGE(values)" },
  { label: "Count", expression: "COUNT(values)" },
  { label: "Minimum", expression: "MIN(values)" },
  { label: "Maximum", expression: "MAX(values)" },
  { label: "Join values", expression: 'ARRAYJOIN(values, ", ")' },
  { label: "Unique values", expression: 'ARRAYJOIN(ARRAYUNIQUE(values), ", ")' },
];

function PrecisionSelect({ value, onChange, label = "Precision" }: { value: number; onChange: (n: number) => void; label?: string }) {
  return (
    <FormField label={label}>
      {(c) => (
        <Select {...c} value={value} onChange={(e) => onChange(Number(e.target.value))}>
          {Array.from({ length: 9 }, (_, i) => (
            <option key={i} value={i}>
              {i === 0 ? "0 (integer)" : `${i} decimal place${i === 1 ? "" : "s"} (${(1.23456789).toFixed(i)})`}
            </option>
          ))}
        </Select>
      )}
    </FormField>
  );
}

export function DateOptionsEditor({ value, onChange, allowTime = true, label = "Date" }: { value: DateOptions; onChange: (v: DateOptions) => void; allowTime?: boolean; label?: string }) {
  const zones = useMemo(() => listTimeZones(), []);
  return (
    <div className="flex flex-col gap-3">
      <FormField label={`${label} format`}>
        {(c) => (
          <Select {...c} value={value.date_format} onChange={(e) => onChange({ ...value, date_format: e.target.value as DateFormat })}>
            {DATE_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      {allowTime && <Checkbox label="Include a time field" checked={value.include_time} onCheckedChange={(on) => onChange({ ...value, include_time: on })} />}
      {value.include_time && (
        <FormField label="Time format">
          {(c) => (
            <Select {...c} value={value.time_format} onChange={(e) => onChange({ ...value, time_format: e.target.value as TimeFormat })}>
              <option value="h12">12 hour (3:30pm)</option>
              <option value="h24">24 hour (15:30)</option>
            </Select>
          )}
        </FormField>
      )}
      <FormField label="Time zone" hint="Choose a fixed zone to show the same time to everyone, or let each viewer see their own zone.">
        {(c) => (
          <Select {...c} value={value.timezone ?? ""} onChange={(e) => onChange({ ...value, timezone: e.target.value || null })}>
            <option value="">Each viewer's own time zone</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        )}
      </FormField>
    </div>
  );
}

type FormatKind = "auto" | ValueFormat["kind"];

/** Display format of a computed number or date (formula and rollup results). */
export function ValueFormatEditor({ value, onChange }: { value: ValueFormat | null | undefined; onChange: (v: ValueFormat | null) => void }) {
  const kind: FormatKind = value?.kind ?? "auto";
  const set = (k: FormatKind) => {
    switch (k) {
      case "auto":
        return onChange(null);
      case "number":
        return onChange({ kind: "number", precision: 2 });
      case "currency":
        return onChange({ kind: "currency", precision: 2, symbol: "$" });
      case "percent":
        return onChange({ kind: "percent", precision: 0 });
      case "duration":
        return onChange({ kind: "duration", format: "h_mm" });
      case "date":
        return onChange({ kind: "date", include_time: false, date_format: "us", time_format: "h12", timezone: null });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <FormField label="Show the result as">
        {(c) => (
          <Select {...c} value={kind} onChange={(e) => set(e.target.value as FormatKind)}>
            <option value="auto">Automatic</option>
            <option value="number">Number</option>
            <option value="currency">Currency</option>
            <option value="percent">Percent</option>
            <option value="duration">Duration</option>
            <option value="date">Date</option>
          </Select>
        )}
      </FormField>
      {value?.kind === "number" && <PrecisionSelect value={value.precision} onChange={(precision) => onChange({ ...value, precision })} />}
      {value?.kind === "percent" && <PrecisionSelect value={value.precision} onChange={(precision) => onChange({ ...value, precision })} />}
      {value?.kind === "currency" && (
        <>
          <FormField label="Currency symbol">{(c) => <Input {...c} maxLength={8} value={value.symbol} onChange={(e) => onChange({ ...value, symbol: e.target.value })} />}</FormField>
          <PrecisionSelect value={value.precision} onChange={(precision) => onChange({ ...value, precision })} />
        </>
      )}
      {value?.kind === "duration" && (
        <FormField label="Duration format">
          {(c) => (
            <Select {...c} value={value.format} onChange={(e) => onChange({ ...value, format: e.target.value as DurationFormat })}>
              {DURATION_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      )}
      {value?.kind === "date" && <DateOptionsEditor value={value} onChange={(d) => onChange({ kind: "date", ...d })} />}
    </div>
  );
}

function WatchedFields({ ctx, existing, value, onChange }: { ctx: KindContext; existing?: Field; value: string[]; onChange: (ids: string[]) => void }) {
  const candidates = ctx.table.fields.filter((f) => f.id !== existing?.id && !["created_time", "last_modified_time", "created_by", "last_modified_by", "autonumber", "formula", "lookup", "rollup", "count", "button"].includes(f.type));
  return (
    <fieldset>
      <legend className="mb-1 text-[0.8125rem] font-medium">Watch these fields</legend>
      <p className="mb-2 text-xs text-muted">Only changes to the checked fields update this value. Leave all unchecked to track every editable field.</p>
      <ul className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
        {candidates.map((f) => (
          <li key={f.id}>
            <Checkbox label={f.name} checked={value.includes(f.id)} onCheckedChange={(on) => onChange(on ? [...value, f.id] : value.filter((x) => x !== f.id))} />
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

export function OptionsEditor({ kind, onChange, ctx, existing, inverseName, onInverseName, creating }: OptionsEditorProps) {
  const otherTables = ctx.tables;
  switch (kind.type) {
    case "single_line_text":
      return <FormField label="Default value (optional)">{(c) => <Input {...c} value={kind.options.default ?? ""} onChange={(e) => onChange({ type: kind.type, options: { default: e.target.value || undefined } })} />}</FormField>;
    case "long_text":
      return <Checkbox label="Enable rich text formatting (markdown)" checked={kind.options.rich} onCheckedChange={(rich) => onChange({ type: kind.type, options: { rich } })} />;
    case "number":
    case "percent":
      return (
        <div className="flex flex-col gap-3">
          <PrecisionSelect value={kind.options.precision} onChange={(precision) => onChange({ ...kind, options: { ...kind.options, precision } })} />
          <Checkbox label="Allow negative numbers" checked={kind.options.allow_negative} onCheckedChange={(allow_negative) => onChange({ ...kind, options: { ...kind.options, allow_negative } })} />
          {kind.type === "number" && (
            <FormField label="Default value (optional)">
              {(c) => (
                <Input
                  {...c}
                  inputMode="decimal"
                  value={kind.options.default === null || kind.options.default === undefined ? "" : String(kind.options.default)}
                  onChange={(e) => {
                    const t = e.target.value.trim();
                    const n = Number(t);
                    onChange({ ...kind, options: { ...kind.options, default: t === "" || Number.isNaN(n) ? undefined : n } });
                  }}
                />
              )}
            </FormField>
          )}
        </div>
      );
    case "currency":
      return (
        <div className="flex flex-col gap-3">
          <FormField label="Currency symbol">
            {(c) => (
              <div className="flex flex-wrap items-center gap-1.5">
                <Input {...c} className="w-24" maxLength={8} value={kind.options.symbol} onChange={(e) => onChange({ ...kind, options: { ...kind.options, symbol: e.target.value } })} />
                {CURRENCY_SYMBOLS.map((s) => (
                  <button key={s} type="button" aria-label={`Use ${s}`} onClick={() => onChange({ ...kind, options: { ...kind.options, symbol: s } })} className="h-8 min-w-8 rounded-md border border-line px-2 text-[0.8125rem] hover:bg-hover">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </FormField>
          <PrecisionSelect value={kind.options.precision} onChange={(precision) => onChange({ ...kind, options: { ...kind.options, precision } })} />
          <Checkbox label="Allow negative numbers" checked={kind.options.allow_negative} onCheckedChange={(allow_negative) => onChange({ ...kind, options: { ...kind.options, allow_negative } })} />
        </div>
      );
    case "duration":
      return (
        <FormField label="Format">
          {(c) => (
            <Select {...c} value={kind.options.format} onChange={(e) => onChange({ type: kind.type, options: { format: e.target.value as DurationFormat } })}>
              {DURATION_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      );
    case "rating":
      return (
        <div className="flex flex-col gap-3">
          <FormField label="Maximum rating">
            {(c) => (
              <Select {...c} value={kind.options.max} onChange={(e) => onChange({ ...kind, options: { ...kind.options, max: Number(e.target.value) } })}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Icon">
            {(c) => (
              <Select {...c} value={kind.options.icon} onChange={(e) => onChange({ ...kind, options: { ...kind.options, icon: e.target.value } })}>
                <option value="star">Star</option>
                <option value="heart">Heart</option>
              </Select>
            )}
          </FormField>
          <div>
            <p className="mb-1 text-[0.8125rem] font-medium">Color</p>
            <ColorSwatchPicker value={kind.options.color} label="Rating color" onChange={(color) => onChange({ ...kind, options: { ...kind.options, color } })} />
          </div>
        </div>
      );
    case "checkbox":
      return (
        <div>
          <p className="mb-1 text-[0.8125rem] font-medium">Color</p>
          <ColorSwatchPicker value={kind.options.color} label="Checkbox color" onChange={(color) => onChange({ ...kind, options: { ...kind.options, color } })} />
        </div>
      );
    case "single_select":
    case "multiple_select":
      return <SelectChoicesEditor choices={kind.options.choices} onChange={(choices) => onChange({ ...kind, options: { choices } })} />;
    case "date":
    case "created_time":
      return <DateOptionsEditor value={kind.options} onChange={(options) => onChange({ ...kind, options })}  />;
    case "last_modified_time":
      return (
        <div className="flex flex-col gap-3">
          <WatchedFields ctx={ctx} existing={existing} value={kind.options.fields} onChange={(fields) => onChange({ ...kind, options: { ...kind.options, fields } })} />
          <DateOptionsEditor value={kind.options.date} onChange={(date) => onChange({ ...kind, options: { ...kind.options, date } })} />
        </div>
      );
    case "last_modified_by":
      return <WatchedFields ctx={ctx} existing={existing} value={kind.options.fields} onChange={(fields) => onChange({ ...kind, options: { ...kind.options, fields } })} />;
    case "email":
    case "url":
    case "phone":
    case "attachment":
    case "created_by":
    case "autonumber":
    case "barcode":
      return <p className="text-[0.8125rem] text-muted">This field type has no options.</p>;
    case "link": {
      const target = otherTables.find((t) => t.id === kind.options.linked_table_id);
      return (
        <div className="flex flex-col gap-3">
          <FormField label="Table to link to" hint={existing ? "The linked table cannot be changed after the field is created." : undefined}>
            {(c) => (
              <EntitySelect
                {...c}
                disabled={!!existing}
                value={kind.options.linked_table_id}
                onValueChange={(id) => onChange({ ...kind, options: { ...kind.options, linked_table_id: id, picker_view_id: null } })}
                options={otherTables.map((t) => ({ value: t.id, label: `${t.name}${t.id === ctx.table.id ? " (this table)" : ""}`, icon: t.icon }))}
              />
            )}
          </FormField>
          <Checkbox label="Allow linking to only one record" checked={kind.options.single} onCheckedChange={(single) => onChange({ ...kind, options: { ...kind.options, single } })} />
          {creating && (
            <FormField label="Name of the field created in the linked table" hint="Leave blank to use the default.">
              {(c) => <Input {...c} value={inverseName} onChange={(e) => onInverseName(e.target.value)} />}
            </FormField>
          )}
          {target && target.views.length > 0 && (
            <FormField label="Limit record choices to a view" hint="Only records in this view of the linked table can be picked.">
              {(c) => (
                <Select {...c} value={kind.options.picker_view_id ?? ""} onChange={(e) => onChange({ ...kind, options: { ...kind.options, picker_view_id: e.target.value || null } })}>
                  <option value="">All records</option>
                  {target.views
                    .filter((v) => !v.personal)
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                </Select>
              )}
            </FormField>
          )}
        </div>
      );
    }
    case "user":
      return (
        <div className="flex flex-col gap-3">
          <Checkbox label="Allow adding multiple users" checked={kind.options.multiple} onCheckedChange={(multiple) => onChange({ ...kind, options: { ...kind.options, multiple } })} />
          <Checkbox label="Notify people when they are added" checked={kind.options.notify} onCheckedChange={(notify) => onChange({ ...kind, options: { ...kind.options, notify } })} />
        </div>
      );
    case "formula":
      return (
        <div className="flex flex-col gap-3">
          <FormulaEditor tableId={ctx.table.id} fields={ctx.table.fields.filter((f) => f.id !== existing?.id)} label="Formula" value={kind.options.expression} onChange={(expression) => onChange({ ...kind, options: { ...kind.options, expression } })} />
          <ValueFormatEditor value={kind.options.format} onChange={(format) => onChange({ ...kind, options: { ...kind.options, format: format ?? undefined } })} />
        </div>
      );
    case "lookup":
    case "rollup":
    case "count": {
      const links = linkFields(ctx.table);
      const link = links.find((l) => l.id === kind.options.link_field_id);
      const targetFields = link ? (ctx.tables.find((t) => t.id === link.options.linked_table_id)?.fields ?? []) : [];
      return (
        <div className="flex flex-col gap-3">
          {links.length === 0 ? (
            <p className="rounded bg-warning-soft px-2 py-1.5 text-[0.8125rem]">This table has no link fields yet. Add a link to another record first.</p>
          ) : (
            <FormField label="Link field">
              {(c) => (
                <Select
                  {...c}
                  value={kind.options.link_field_id}
                  onChange={(e) => onChange({ ...kind, options: { ...kind.options, link_field_id: e.target.value, ...(kind.type !== "count" ? { target_field_id: "" } : {}) } } as FieldKind)}
                >
                  {!link && <option value="">Choose a link field…</option>}
                  {links.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          )}
          {kind.type !== "count" && (
            <FormField label="Field to use from the linked table">
              {(c) => (
                <Select {...c} disabled={!link} value={kind.options.target_field_id} onChange={(e) => onChange({ ...kind, options: { ...kind.options, target_field_id: e.target.value } } as FieldKind)}>
                  <option value="">Choose a field…</option>
                  {targetFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          )}
          {kind.type === "rollup" && (
            <>
              <FormField label="Aggregation">
                {(c) => (
                  <Select
                    {...c}
                    value={ROLLUP_PRESETS.find((p) => p.expression === kind.options.expression)?.expression ?? "__custom"}
                    onChange={(e) => e.target.value !== "__custom" && onChange({ ...kind, options: { ...kind.options, expression: e.target.value } })}
                  >
                    {ROLLUP_PRESETS.map((p) => (
                      <option key={p.expression} value={p.expression}>
                        {p.label}
                      </option>
                    ))}
                    <option value="__custom">Custom formula</option>
                  </Select>
                )}
              </FormField>
              <FormulaEditor tableId={ctx.table.id} fields={targetFields} kind="rollup" rows={2} label="Rollup formula (over values)" placeholder="SUM(values)" value={kind.options.expression} onChange={(expression) => onChange({ ...kind, options: { ...kind.options, expression } })} />
              <ValueFormatEditor value={kind.options.format} onChange={(format) => onChange({ ...kind, options: { ...kind.options, format: format ?? undefined } })} />
            </>
          )}
        </div>
      );
    }
    case "button":
      return (
        <div className="flex flex-col gap-3">
          <FormField label="Button label">{(c) => <Input {...c} maxLength={100} value={kind.options.label} onChange={(e) => onChange({ ...kind, options: { ...kind.options, label: e.target.value } })} />}</FormField>
          <FormulaEditor tableId={ctx.table.id} fields={ctx.table.fields.filter((f) => f.id !== existing?.id)} rows={3} label="URL formula" placeholder={'e.g. "https://example.com/" & {Name}'} value={kind.options.url_formula} onChange={(url_formula) => onChange({ ...kind, options: { ...kind.options, url_formula } })} />
          <p className="text-xs text-muted">Only http, https and mailto links open when the button is clicked.</p>
        </div>
      );
  }
}

