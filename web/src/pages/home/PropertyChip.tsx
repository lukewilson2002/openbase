/**
 * The dashed Property chip of the capture box (HOME-3): set any other property of the collection the capture goes to, as
 * a typed value ("Status", "In progress"). A creator can also start a new property from a value; its type is guessed from
 * what was typed (FLD-1) by the same module as the record page's Add property, so the two agree.
 */
import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Field, Table } from "@/api/types";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { Button } from "@/components/ui/button";
import { CaptureChip } from "@/components/ui/capture-chip";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { SheetActions } from "@/components/ui/sheet";
import { isComputed } from "@/lib/cells/kinds";
import { chipText, planProperty, valueFor, whyNoValue, type PropertyPlan, type ValueCtx } from "@/record/newProperty";
import { PickerShell } from "./PickerShell";

/** A property the capture will set: an existing one with its parsed value, or a new one made when the capture is added. */
export type PropertyEntry =
  | { kind: "field"; field: Field; value: unknown; label: string }
  | { kind: "new"; name: string; text: string; plan: PropertyPlan; label: string };

export interface PropertyChipProps {
  schema: BaseSchema;
  table: Table;
  /** Properties that are taken: the title, the page, the date the date chip fills, and those already set. */
  taken: ReadonlySet<string>;
  ctx: Omit<ValueCtx, "users">;
  /** Creators may start a new property from a value. */
  canCreate: boolean;
  onAdd: (entry: PropertyEntry) => void;
}

/** What a typed value can be set on: not computed, not files (those are pasted), not links (they need the record picker). */
const settable = (f: Field): boolean => !isComputed(f) && f.type !== "attachment" && f.type !== "link";

export function PropertyChip({ schema, table, taken, ctx, canCreate, onAdd }: PropertyChipProps) {
  const [open, setOpen] = useState(false);
  const available = table.fields.filter((f) => settable(f) && !taken.has(f.id));
  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      title="Property"
      trigger={(props) => (
        <CaptureChip dashed {...props}>
          <Icon icon={Plus} size="sm" /> Property
        </CaptureChip>
      )}
    >
      {open && (
        <Body
          schema={schema}
          table={table}
          available={available}
          ctx={ctx}
          canCreate={canCreate}
          onAdd={(entry) => {
            setOpen(false);
            onAdd(entry);
          }}
        />
      )}
    </PickerShell>
  );
}

type Step = { name: "list" } | { name: "field"; field: Field } | { name: "new" };

function Body({ schema, table, available, ctx, canCreate, onAdd }: Pick<PropertyChipProps, "schema" | "table" | "ctx" | "canCreate" | "onAdd"> & { available: Field[] }) {
  const [step, setStep] = useState<Step>({ name: "list" });
  const people = useQuery({ queryKey: keys.baseCollaborators(schema.id), queryFn: () => api.bases.collaborators(schema.id), staleTime: 60_000 });
  const users = people.data ?? [];
  if (step.name === "field") return <ValueStep field={step.field} users={users} ctx={ctx} onBack={() => setStep({ name: "list" })} onAdd={onAdd} />;
  if (step.name === "new") return <NewStep schema={schema} table={table} onBack={() => setStep({ name: "list" })} onAdd={onAdd} />;
  return (
    <ul aria-label="Properties" className="flex flex-col">
      {available.map((f) => (
        <li key={f.id}>
          <button type="button" onClick={() => setStep({ name: "field", field: f })} className="flex h-control-lg w-full items-center gap-2 rounded-md px-2.5 text-left text-ui hover:bg-hover focus-visible:bg-hover max-md:min-h-control-touch">
            <FieldTypeIcon type={f.type} />
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
          </button>
        </li>
      ))}
      {available.length === 0 && !canCreate && <li className="px-2.5 py-3 text-label text-muted">No other property can be set here.</li>}
      {canCreate && (
        <li>
          <button type="button" onClick={() => setStep({ name: "new" })} className="flex h-control-lg w-full items-center gap-2 rounded-md px-2.5 text-left text-ui text-primary-text hover:bg-hover focus-visible:bg-hover max-md:min-h-control-touch">
            <Icon icon={Plus} /> New property
          </button>
        </li>
      )}
    </ul>
  );
}

function ValueStep({ field, users, ctx, onBack, onAdd }: { field: Field; users: ValueCtx["users"]; ctx: PropertyChipProps["ctx"]; onBack: () => void; onAdd: PropertyChipProps["onAdd"] }) {
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const why = whyNoValue(field.type);
  const submit = () => {
    const res = valueFor(field, text, { ...ctx, users });
    if (!res.ok) return setError(res.error);
    if (res.value === null) return setError(`Type a value for ${field.name}.`);
    onAdd({ kind: "field", field, value: res.value, label: `${field.name}: ${text.trim()}` });
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor={id} className="text-label font-semibold">
        {field.name}
      </label>
      <Input id={id} data-autofocus autoFocus value={text} onChange={(e) => (setText(e.target.value), setError(null))} aria-invalid={error ? true : undefined} aria-describedby={`${id}-hint`} autoComplete="off" className="max-md:text-read-phone" />
      <p id={`${id}-hint`} role={error ? "alert" : undefined} className={error ? "text-label text-danger" : "text-label text-muted"}>
        {error ?? why ?? hintFor(field)}
      </p>
      <SheetActions>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" variant="primary" size="sm">
          Set {field.name}
        </Button>
      </SheetActions>
    </form>
  );
}

function hintFor(field: Field): string {
  switch (field.type) {
    case "single_select":
    case "multiple_select":
      return "Type the name of a choice.";
    case "checkbox":
      return "Type yes to tick it.";
    case "date":
      return "Type a date, such as Friday or Nov 14.";
    case "user":
      return "Type a person's name or email.";
    default:
      return "Type the value.";
  }
}

function NewStep({ schema, table, onBack, onAdd }: { schema: BaseSchema; table: Table; onBack: () => void; onAdd: PropertyChipProps["onAdd"] }) {
  const id = useId();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const plan = useMemo(() => planProperty(text, null, { table, tables: schema.tables }), [text, table, schema.tables]);
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return setProblem("Name the property.");
    if (table.fields.some((f) => f.name.toLowerCase() === trimmed.toLowerCase())) return setProblem(`${table.name} already has a property called ${trimmed}.`);
    onAdd({ kind: "new", name: trimmed, text, plan, label: `${trimmed}: ${text.trim()}` });
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor={`${id}-name`} className="text-label font-semibold">
        Name
      </label>
      <Input id={`${id}-name`} data-autofocus autoFocus value={name} onChange={(e) => (setName(e.target.value), setProblem(null))} autoComplete="off" className="max-md:text-read-phone" />
      <label htmlFor={`${id}-value`} className="text-label font-semibold">
        Value
      </label>
      <Input id={`${id}-value`} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" className="max-md:text-read-phone" />
      <CaptureChip static className="self-start">
        {chipText(plan, text)}
      </CaptureChip>
      {problem && (
        <p role="alert" className="text-label text-danger">
          {problem}
        </p>
      )}
      <SheetActions>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" variant="primary" size="sm">
          Add property
        </Button>
      </SheetActions>
    </form>
  );
}
