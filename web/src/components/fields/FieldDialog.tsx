/**
 * Add or edit a property (FLD-2): name, description, type (in today's groups, each with a one-line description)
 * and the options of the chosen type. A dialog on a desktop and a full-screen sheet on a phone, where the type
 * list is a bottom sheet of its own (PH-3). Adding posts `CreateField` (`options` always present); editing
 * patches only what changed, and warns before a type change that may lose data, saying how many values go.
 */
import { useId, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { errorMessage } from "@/api/client";
import { keys } from "@/api/keys";
import { schemaApi, type FieldMutationResult } from "@/api/records";
import type { BaseSchema, Field, FieldKind, FieldType, Table } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorMark } from "@/components/ui/color-mark";
import { Dialog } from "@/components/ui/dialog";
import { FIELD_TYPE_ICONS, FIELD_TYPE_LABELS } from "@/components/ui/field-type-icon";
import { Icon } from "@/components/ui/icon";
import { Field as FormField, Input, Textarea } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { OptionsEditor } from "./OptionsEditor";
import { PropertyTypeList, TYPE_DESCRIPTIONS } from "./PropertyTypePicker";
import { canBePrimary, clearedSentence, defaultKind, draftFromField, kindChange, needsConfirmation, toCreateField, toUpdateField, validateDraft, type FieldDraft, type KindContext } from "./fieldKinds";
import { useFilledCount } from "./useFilledCount";

export type FieldDialogState =
  /** `type` starts the new property as that type ("Add a date property" from a calendar that has none); `name` fills in its name. */
  | { mode: "create"; relativeTo?: { fieldId: string; side: "left" | "right" }; type?: FieldType; name?: string }
  | { mode: "edit"; field: Field; focus?: "name" | "type" };

export interface FieldDialogProps {
  state: FieldDialogState;
  schema: BaseSchema;
  table: Table;
  onOpenChange: (open: boolean) => void;
  /** Called after the server accepted the change (the base schema is refetched first). */
  onSaved?: (field: Field, relativeTo?: { fieldId: string; side: "left" | "right" }) => void;
}

/** The type row: the chosen type and what it holds, which opens the list in place (a desktop) or as a bottom sheet (a phone). */
function TypeField({ value, onChange, unavailable, initiallyOpen }: { value: FieldType; onChange: (t: FieldType) => void; unavailable?: (t: FieldType) => string | null; initiallyOpen: boolean }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [open, setOpen] = useState(initiallyOpen);
  const labelId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const choose = (t: FieldType) => {
    onChange(t);
    setOpen(false);
    // The list was opened from this button; it is where the keyboard picks up again (the sheet returns focus itself).
    if (desktop) button.current?.focus();
  };
  return (
    <div>
      <span id={labelId} className="text-label font-medium">
        Type
      </span>
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${labelId}-value`}
        onClick={() => setOpen((o) => !o)}
        className="mt-1 flex min-h-control-md w-full items-center gap-2.5 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-left hover:border-faint max-md:min-h-control-touch"
      >
        <Icon icon={FIELD_TYPE_ICONS[value]} className="text-muted" />
        <span id={`${labelId}-value`} className="min-w-0 flex-1">
          <span className="block text-ui">{FIELD_TYPE_LABELS[value]}</span>
          <span className="block truncate text-meta text-muted">{TYPE_DESCRIPTIONS[value]}</span>
        </span>
        <Icon icon={ChevronDown} className={cn("text-muted transition-transform", open && desktop && "rotate-180")} />
      </button>
      {open && desktop && (
        <div className="mt-2 max-h-72 overflow-y-auto overscroll-contain rounded-md border border-line p-2">
          <PropertyTypeList value={value} onChange={choose} unavailable={unavailable} />
        </div>
      )}
      {!desktop && (
        <Sheet open={open} onOpenChange={setOpen} title="Property type" doneLabel="Close">
          <PropertyTypeList value={value} onChange={choose} unavailable={unavailable} />
        </Sheet>
      )}
    </div>
  );
}

export function FieldDialog({ state, schema, table, onOpenChange, onSaved }: FieldDialogProps) {
  const qc = useQueryClient();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const existing = state.mode === "edit" ? state.field : undefined;
  const ctx = useMemo<KindContext>(() => ({ table, tables: schema.tables }), [table, schema.tables]);
  const [draft, setDraft] = useState<FieldDraft>(() => (existing ? draftFromField(existing) : { name: (state.mode === "create" && state.name) || "", description: "", kind: defaultKind((state.mode === "create" && state.type) || "text", ctx), inverseName: "" }));
  const [showDescription, setShowDescription] = useState(!!draft.description);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const isTitle = existing?.id === table.primary_field_id;
  const isPage = !!existing && existing.id === table.body_field_id;
  const issues = useMemo(() => validateDraft(draft, ctx, existing), [draft, ctx, existing]);
  const nameIssue = issues.find((i) => i.field === "name");
  const optionIssues = issues.filter((i) => i.field === "options");
  const change = existing ? kindChange(existing, draft.kind) : null;
  // The count is asked for only once a change that could take values away has been picked.
  const filled = useFilledCount(table, existing, !!change?.clears);
  const needsConfirm = !!change && needsConfirmation(change, filled);
  const cleared = change ? clearedSentence(change.clears, filled) : null;
  // The page loses its job when its type stops being rich text (the server clears the pointer); nothing is refused.
  const losesPage = isPage && draft.kind.type !== "rich_text";
  const title = existing ? "Edit property" : "Add property";

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
      description={
        existing ? (
          `Change the name, type or options of “${existing.name}”.`
        ) : (
          <span className="inline-flex items-center gap-1.5">
            Add a property to <ColorMark hue={table.color} name={table.name} size={10} /> {table.name}.
          </span>
        )
      }
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {existing ? "Save" : "Add property"}
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
        <FormField label="Name" error={submitted ? nameIssue?.message : undefined}>
          {(c) => <Input {...c} autoFocus maxLength={255} className="max-md:h-control-touch" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />}
        </FormField>

        {showDescription ? (
          <FormField label="Description (optional)">{(c) => <Textarea {...c} rows={2} maxLength={20000} value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />}</FormField>
        ) : (
          <button type="button" className="min-h-6 self-start text-label text-primary-text underline hover:no-underline max-md:min-h-control-touch" onClick={() => setShowDescription(true)}>
            Add a description
          </button>
        )}

        <TypeField
          value={draft.kind.type}
          unavailable={isTitle ? (t) => (canBePrimary(t) ? null : "Can't be the title") : undefined}
          // Adding a property starts with the list open where there is room for it; on a phone it would cover the form.
          initiallyOpen={(state.mode === "create" && !state.type && desktop) || (state.mode === "edit" && state.focus === "type")}
          onChange={(t) => {
            if (t !== draft.kind.type) {
              setKind(defaultKind(t, ctx));
              setConfirmed(false);
            }
          }}
        />

        {(change?.warning || losesPage) && (
          <div role="status" className={cn("flex flex-col gap-1.5 rounded-md px-3 py-2 text-label", change?.risk === "lossy" ? "bg-warning-soft" : "bg-subtle")}>
            {change?.warning && <p>{change.warning}</p>}
            {cleared && <p className="font-semibold">{cleared}</p>}
            {losesPage && <p>This is the collection's page. Records keep the text in it, but they have no page until you choose another property.</p>}
            {needsConfirm && <Checkbox className="mt-1" label="I understand that existing values may be lost" checked={confirmed} onCheckedChange={setConfirmed} />}
            {needsConfirm && submitted && !confirmed && <p className="text-meta text-danger">Tick the box to continue.</p>}
          </div>
        )}

        <section aria-label="Options" className="rounded-md border border-line p-3">
          <OptionsEditor kind={draft.kind} onChange={setKind} ctx={ctx} existing={existing} inverseName={draft.inverseName} onInverseName={(inverseName) => setDraft((d) => ({ ...d, inverseName }))} creating={!existing} />
          {submitted && optionIssues.length > 0 && (
            <ul role="alert" className="mt-2 text-meta text-danger">
              {optionIssues.map((i) => (
                <li key={i.message}>{i.message}</li>
              ))}
            </ul>
          )}
        </section>

        {error && (
          <p role="alert" className="text-label text-danger">
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
