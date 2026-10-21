/** Operand editors for filter conditions, one per operand kind (text, number, select, user, record, date...). */
import { useId, useState } from "react";
import { useQueries, useQuery, keepPreviousData } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { recordKeys, recordsApi } from "@/api/records";
import type { Collaborator, DateOperand, Field, FilterOp, Table } from "@/api/types";
import { Input } from "@/components/ui/input";
import { InlineSelect } from "./InlineSelect";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDebounced } from "@/components/record/editors/useDebounced";
import { cn } from "@/lib/cn";
import { DATE_MODE_LABELS, dateModesFor, makeDateOperand, modeHasDays, operandKindFor, type DateMode } from "@/lib/cells/filters";
import { displayText } from "@/lib/cells/format";
import { selectChoicesOf } from "@/lib/cells/kinds";
import { parseNumber } from "@/lib/cells/text";

export interface OperandEditorProps {
  field: Field;
  op: FilterOp;
  value: unknown;
  /** `typing` marks keystroke edits, which callers may debounce. */
  onChange: (value: unknown, opts?: { typing?: boolean }) => void;
  collaborators: readonly Collaborator[];
  /** Tables of the base, to show names of linked records already chosen. */
  tables?: readonly Table[];
  readOnly?: boolean;
}

const ME = "me";

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : [];
}

/** A button that opens a checkbox list; used for multi-valued operands. */
function MultiPicker({ label, options, selected, onChange, disabled, search }: { label: string; options: { id: string; label: string }[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean; search?: { query: string; onQuery: (q: string) => void; loading?: boolean } }) {
  const names = selected.map((id) => options.find((o) => o.id === id)?.label ?? id);
  const summary = names.length === 0 ? "Choose…" : names.length <= 2 ? names.join(", ") : `${names.length} selected`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} aria-label={label} className="flex h-8 min-w-36 max-w-56 items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-left text-[0.8125rem] disabled:opacity-70">
          <span className={cn("truncate", names.length === 0 && "text-faint")}>{summary}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        {search && (
          <div className="p-1">
            <Input aria-label={`Search ${label}`} placeholder="Search" value={search.query} onChange={(e) => search.onQuery(e.target.value)} />
          </div>
        )}
        <ul role="listbox" aria-multiselectable aria-label={label} className="max-h-56 overflow-y-auto">
          {options.map((o) => {
            const on = selected.includes(o.id);
            return (
              <li key={o.id} role="option" aria-selected={on}>
                <button type="button" onClick={() => onChange(on ? selected.filter((x) => x !== o.id) : [...selected, o.id])} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[0.8125rem] hover:bg-hover">
                  <span className="truncate">{o.label}</span>
                  {on && <Check aria-hidden className="size-4 text-primary-text" />}
                </button>
              </li>
            );
          })}
          {options.length === 0 && <li className="px-2 py-3 text-center text-[0.8125rem] text-muted">{search?.loading ? "Searching…" : "Nothing to choose."}</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function RecordPicker({ field, selected, onChange, disabled, tables }: { field: Extract<Field, { type: "link" }>; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean; tables?: readonly Table[] }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 200);
  const table = field.options.linked_table_id;
  const results = useQuery({ queryKey: recordKeys.lookup(table, dq, field.options.picker_view_id ?? null), queryFn: ({ signal }) => recordsApi.lookup(table, dq, { viewId: field.options.picker_view_id, signal }), placeholderData: keepPreviousData });
  // Names of already-chosen records (their ids are all the filter stores).
  const known = useQueries({ queries: selected.map((id) => ({ queryKey: recordKeys.record(table, id), queryFn: () => recordsApi.get(table, id), staleTime: 60_000 })) });
  const nameOf = new Map<string, string>();
  known.forEach((q2, i) => {
    const rec = q2.data;
    const id = selected[i]!;
    const primary = tables?.find((t) => t.id === table)?.fields.find((f) => f.id === tables.find((t2) => t2.id === table)?.primary_field_id);
    if (rec) nameOf.set(id, primary ? displayText(primary, rec.values[primary.id]) || id : id);
  });
  for (const r of results.data?.records ?? []) nameOf.set(r.id, r.name);
  const options = [...selected.map((id) => ({ id, label: nameOf.get(id) ?? id })), ...(results.data?.records ?? []).filter((r) => !selected.includes(r.id)).map((r) => ({ id: r.id, label: r.name }))];
  return <MultiPicker label={`Records in ${field.name}`} options={options} selected={selected} onChange={onChange} disabled={disabled} search={{ query: q, onQuery: setQ, loading: results.isFetching }} />;
}

function normaliseDate(v: unknown, op: FilterOp): DateOperand {
  if (typeof v === "string" && v) return { mode: "exact_date", date: v };
  if (v && typeof v === "object" && "mode" in v) return v as DateOperand;
  return makeDateOperand(op === "is_within" ? "past_week" : "today");
}

function DateOperandEditor({ op, value, onChange, disabled }: { op: FilterOp; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const operand = normaliseDate(value, op);
  const id = useId();
  const days = "days" in operand ? operand.days : 1;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <InlineSelect aria-label="Date" width="w-48" disabled={disabled} value={operand.mode} onChange={(e) => onChange(makeDateOperand(e.target.value as DateMode, { days, date: operand.mode === "exact_date" ? operand.date : undefined }))}>
        {dateModesFor(op).map((m) => (
          <option key={m} value={m}>
            {DATE_MODE_LABELS[m]}
          </option>
        ))}
      </InlineSelect>
      {modeHasDays(operand.mode) && (
        <Input
          id={id}
          aria-label="Number of days"
          type="number"
          min={0}
          max={100000}
          disabled={disabled}
          className="w-20"
          value={days}
          onChange={(e) => onChange(makeDateOperand(operand.mode, { days: Number(e.target.value) }))}
        />
      )}
      {operand.mode === "exact_date" && <Input aria-label="Date" type="date" disabled={disabled} className="w-40" value={operand.date} onChange={(e) => onChange(makeDateOperand("exact_date", { date: e.target.value }))} />}
    </div>
  );
}

export function OperandEditor({ field, op, value, onChange, collaborators, tables, readOnly }: OperandEditorProps) {
  const kind = operandKindFor(field, op);
  const disabled = readOnly;
  switch (kind) {
    case "none":
      return null;
    case "text":
      return <Input aria-label="Value" className="w-48" disabled={disabled} value={typeof value === "string" ? value : value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value, { typing: true })} />;
    case "text_list":
      return (
        <Input
          aria-label="Values, separated by commas"
          placeholder="a, b, c"
          className="w-48"
          disabled={disabled}
          value={asArray(value).join(", ")}
          onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean), { typing: true })}
        />
      );
    case "number":
      return (
        <Input
          aria-label="Value"
          inputMode="decimal"
          className="w-32"
          disabled={disabled}
          value={typeof value === "number" ? String(value) : typeof value === "string" ? value : ""}
          onChange={(e) => {
            const t = e.target.value;
            const p = parseNumber(t, null);
            // Keep partial input (like "-" or "1.") as text until it parses.
            onChange(p && /^-?\d+(\.\d+)?$/.test(t.trim()) ? p.value : t, { typing: true });
          }}
        />
      );
    case "bool":
      return (
        <InlineSelect aria-label="Value" width="w-36" disabled={disabled} value={value === false ? "false" : "true"} onChange={(e) => onChange(e.target.value === "true")}>
          <option value="true">checked</option>
          <option value="false">unchecked</option>
        </InlineSelect>
      );
    case "choice_one":
      return (
        <InlineSelect aria-label="Option" width="w-44" disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {selectChoicesOf(field).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </InlineSelect>
      );
    case "choice_many":
      return <MultiPicker label={`Options in ${field.name}`} disabled={disabled} options={selectChoicesOf(field).map((c) => ({ id: c.id, label: c.name }))} selected={asArray(value)} onChange={onChange} />;
    case "user_one":
      return (
        <InlineSelect aria-label="Person" width="w-48" disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          <option value={ME}>Me (current user)</option>
          {collaborators.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </InlineSelect>
      );
    case "user_many":
      return <MultiPicker label={`People in ${field.name}`} disabled={disabled} options={[{ id: ME, label: "Me (current user)" }, ...collaborators.map((u) => ({ id: u.id, label: u.name }))]} selected={asArray(value)} onChange={onChange} />;
    case "record_many":
      return field.type === "link" ? <RecordPicker field={field} disabled={disabled} selected={asArray(value)} onChange={onChange} tables={tables} /> : null;
    case "date":
      return <DateOperandEditor op={op} value={value} onChange={onChange} disabled={disabled} />;
  }
}

/** Short text for a condition's operand, used in toolbar summaries and tests. */
export function operandSummary(field: Field, value: unknown, collaborators: readonly Collaborator[]): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map((v) => collaborators.find((u) => u.id === v)?.name ?? selectChoicesOf(field).find((c) => c.id === v)?.name ?? String(v)).join(", ");
  if (typeof value === "object" && "mode" in value) return DATE_MODE_LABELS[(value as DateOperand).mode];
  return displayText(field, value);
}
