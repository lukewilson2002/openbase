/**
 * Create or edit a field: name, description, type (with icons) and the options of the chosen
 * type. Creating posts `CreateField` (`options` always present); editing patches only what
 * changed, and warns before a type change that may lose data.
 */
import { EntityLabel } from "@/components/icons/EntityIcon";
import { useId, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { errorMessage } from "@/api/client";
import { keys } from "@/api/keys";
import { schemaApi, type FieldMutationResult } from "@/api/records";
import type { BaseSchema, Field, FieldKind, FieldType, Table } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { FIELD_TYPE_ICONS, FIELD_TYPE_LABELS } from "@/components/ui/field-type-icon";
import { Field as FormField, Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { OptionsEditor } from "./OptionsEditor";
import { FIELD_TYPE_GROUPS, canBePrimary, conversionRisk, conversionWarning, defaultKind, draftFromField, toCreateField, toUpdateField, validateDraft, type FieldDraft, type KindContext } from "./fieldKinds";

export type FieldDialogState =
  /** `type` starts the new field as that type ("Add a date field" from a calendar that has none). */
  | { mode: "create"; relativeTo?: { fieldId: string; side: "left" | "right" }; type?: FieldType }
  | { mode: "edit"; field: Field; focus?: "name" | "type" };

export interface FieldDialogProps {
  state: FieldDialogState;
  schema: BaseSchema;
  table: Table;
  onOpenChange: (open: boolean) => void;
  /** Called after the server accepted the change (the base schema is refetched first). */
  onSaved?: (field: Field, relativeTo?: { fieldId: string; side: "left" | "right" }) => void;
}

const TYPE_DESCRIPTIONS: Partial<Record<FieldType, string>> = {
  single_line_text: "A short piece of text",
  long_text: "Paragraphs, optionally with markdown",
  number: "Whole or decimal numbers",
  currency: "Money, with a symbol",
  percent: "A percentage",
  duration: "Hours, minutes and seconds",
  rating: "Stars or hearts",
  checkbox: "Checked or not",
  single_select: "Pick one option",
  multiple_select: "Pick several options",
  date: "A date, optionally with a time",
  email: "An email address",
  url: "A web link",
  phone: "A phone number",
  attachment: "Files and images",
  link: "Link to records in a table",
  user: "People who can access this base",
  formula: "Calculate a value from other fields",
  lookup: "Show fields from linked records",
  rollup: "Summarize fields from linked records",
  count: "Count linked records",
  created_time: "When the record was created",
  last_modified_time: "When the record last changed",
  created_by: "Who created the record",
  last_modified_by: "Who last changed the record",
  autonumber: "An automatically increasing number",
  barcode: "A barcode value",
  button: "A button that opens a link",
};

function TypePicker({ value, onChange, primary, initiallyOpen }: { value: FieldType; onChange: (t: FieldType) => void; primary: boolean; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const Icon = FIELD_TYPE_ICONS[value];
  const labelId = useId();
  return (
    <div>
      <span id={labelId} className="text-[0.8125rem] font-medium">
        Field type
      </span>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelId}
        onClick={() => setOpen((o) => !o)}
        className="mt-1 flex h-9 w-full items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-left text-[0.8125rem] hover:border-faint"
      >
        <Icon aria-hidden className="size-4 text-muted" />
        <span className="flex-1">{FIELD_TYPE_LABELS[value]}</span>
        <ChevronDown aria-hidden className={cn("size-4 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div role="listbox" aria-label="Field types" className="mt-2 max-h-64 overflow-y-auto rounded-md border border-line p-2">
          {FIELD_TYPE_GROUPS.map((g) => (
            <div key={g.label} className="mb-2 last:mb-0">
              <p className="mb-1 px-1 text-xs font-medium uppercase tracking-wide text-muted">{g.label}</p>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {g.types
                  .filter((t) => !primary || canBePrimary(t))
                  .map((t) => {
                    const I = FIELD_TYPE_ICONS[t];
                    return (
                      <button
                        key={t}
                        type="button"
                        role="option"
                        aria-selected={t === value}
                        onClick={() => {
                          onChange(t);
                          setOpen(false);
                        }}
                        className={cn("flex items-center gap-2 rounded px-2 py-1.5 text-left text-[0.8125rem] hover:bg-hover", t === value && "bg-primary-soft")}
                      >
                        <I aria-hidden className="size-4 shrink-0 text-muted" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{FIELD_TYPE_LABELS[t]}</span>
                          <span className="block truncate text-xs text-muted">{TYPE_DESCRIPTIONS[t]}</span>
                        </span>
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FieldDialog({ state, schema, table, onOpenChange, onSaved }: FieldDialogProps) {
  const qc = useQueryClient();
  const existing = state.mode === "edit" ? state.field : undefined;
  const ctx = useMemo<KindContext>(() => ({ table, tables: schema.tables }), [table, schema.tables]);
  const [draft, setDraft] = useState<FieldDraft>(() => (existing ? draftFromField(existing) : { name: "", description: "", kind: defaultKind((state.mode === "create" && state.type) || "single_line_text", ctx), inverseName: "" }));
  const [showDescription, setShowDescription] = useState(!!draft.description);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const isPrimary = existing?.id === table.primary_field_id;
  const issues = useMemo(() => validateDraft(draft, ctx, existing), [draft, ctx, existing]);
  const nameIssue = issues.find((i) => i.field === "name");
  const optionIssues = issues.filter((i) => i.field === "options");
  const risk = existing ? conversionRisk(existing.type, draft.kind.type) : "none";
  const warning = existing ? conversionWarning(existing.type, draft.kind.type) : null;
  const needsConfirm = risk === "lossy";
  const title = existing ? "Edit field" : "Add a field";

  const setKind = (kind: FieldKind) => setDraft((d) => ({ ...d, kind }));

  const save = async () => {
    setSubmitted(true);
    if (issues.length > 0 || (needsConfirm && !confirmed)) return;
    setSaving(true);
    setError(null);
    try {
      let saved: FieldMutationResult | null = null;
      if (existing) {
        const body = toUpdateField(existing, draft);
        if (body) saved = await schemaApi.updateField(existing.id, body);
      } else {
        saved = await schemaApi.createField(table.id, toCreateField(draft));
      }
      if (saved) {
        await qc.invalidateQueries({ queryKey: keys.base(schema.id) });
        // Schema changes can alter what record queries return.
        void qc.invalidateQueries({ queryKey: ["records"] });
        onSaved?.(saved, state.mode === "create" ? state.relativeTo : undefined);
      }
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !saving && onOpenChange(o)}
      title={title}
      description={existing ? `Change the name, type or options of "${existing.name}".` : <span className="inline-flex items-center gap-1.5">Add a field to <EntityLabel icon={table.icon}>{table.name}.</EntityLabel></span>}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {existing ? "Save" : "Create field"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <FormField label="Field name" error={submitted ? nameIssue?.message : undefined}>
          {(c) => <Input {...c} autoFocus={state.mode === "create" || state.mode === "edit"} maxLength={255} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />}
        </FormField>

        {showDescription ? (
          <FormField label="Description (optional)">{(c) => <Textarea {...c} rows={2} maxLength={20000} value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />}</FormField>
        ) : (
          <button type="button" className="self-start text-[0.8125rem] text-primary hover:underline" onClick={() => setShowDescription(true)}>
            Add a description
          </button>
        )}

        <TypePicker
          value={draft.kind.type}
          primary={isPrimary}
          initiallyOpen={(state.mode === "create" && !state.type) || (state.mode === "edit" && state.focus === "type")}
          onChange={(t) => {
            if (t !== draft.kind.type) {
              setKind(defaultKind(t, ctx));
              setConfirmed(false);
            }
          }}
        />

        {warning && (
          <div role="status" className={cn("rounded-md px-3 py-2 text-[0.8125rem]", risk === "lossy" ? "bg-warning-soft" : "bg-subtle")}>
            <p>{warning}</p>
            {needsConfirm && <Checkbox className="mt-2" label="I understand that existing values may be lost" checked={confirmed} onCheckedChange={setConfirmed} />}
            {needsConfirm && submitted && !confirmed && <p className="mt-1 text-xs text-danger">Tick the box to continue.</p>}
          </div>
        )}

        <section aria-label="Field options" className="rounded-md border border-line p-3">
          <OptionsEditor kind={draft.kind} onChange={setKind} ctx={ctx} existing={existing} inverseName={draft.inverseName} onInverseName={(inverseName) => setDraft((d) => ({ ...d, inverseName }))} creating={!existing} />
          {submitted && optionIssues.length > 0 && (
            <ul role="alert" className="mt-2 text-xs text-danger">
              {optionIssues.map((i) => (
                <li key={i.message}>{i.message}</li>
              ))}
            </ul>
          )}
        </section>

        {error && (
          <p role="alert" className="text-[0.8125rem] text-danger">
            {error}
          </p>
        )}
        {/* Lets Enter in the name box submit the form. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
          Save
        </button>
      </form>
    </Dialog>
  );
}
