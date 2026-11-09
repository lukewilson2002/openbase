/**
 * "Add property" at the foot of a record page's property list (REC-4, creators): an inline box with a Name and a
 * Value. As the value is typed a chip says what type it looks like (FLD-1), next to Change type, which offers
 * every type. Enter (or Add property) makes the property with that type, puts it last in the default view (a new
 * property always lands after the ones the view lists) and sets this record's value; Escape cancels. A type that
 * cannot be guessed from a value (a link, a formula) continues in the property dialog.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { errorMessage } from "@/api/client";
import { keys } from "@/api/keys";
import { schemaApi } from "@/api/records";
import type { BaseSchema, Field, FieldType, Table } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import type { EditorEnv } from "@/components/record/editors/env";
import { PropertyTypeList } from "@/components/fields/PropertyTypePicker";
import { toCreateField, validateDraft, type KindContext } from "@/components/fields/fieldKinds";
import { Button } from "@/components/ui/button";
import { CaptureChip } from "@/components/ui/capture-chip";
import { Field as Labelled, Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { chipText, needsSetup, planProperty, probeField, valueFor, whyNoValue, type ValueCtx } from "./newProperty";
import type { RecordSave } from "./useRecordSave";

export interface AddPropertyProps {
  schema: BaseSchema;
  table: Table;
  env: EditorEnv;
  save: RecordSave;
  /** Continues in the property dialog, for a type the box cannot set up. */
  onSetup(name: string, type: FieldType): void;
  /** Opens the box when it changes to something above 0 (the page's block menu: Property). */
  openRequest?: number;
}

export function AddProperty({ schema, table, env, save, onSetup, openRequest = 0 }: AddPropertyProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [chosen, setChosen] = useState<FieldType | null>(null);
  const [picking, setPicking] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const changeType = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const hintId = useId();
  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);
  // At the foot of a long page the box opens below the fold: bring all of it into view, not just the Name.
  useEffect(() => {
    if (open) form.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const kindCtx = useMemo<KindContext>(() => ({ table, tables: schema.tables }), [table, schema.tables]);
  const plan = useMemo(() => planProperty(value, chosen, kindCtx), [value, chosen, kindCtx]);
  const noValue = whyNoValue(plan.kind.type);
  const valueCtx = (): ValueCtx => ({ timeZone: env.timeZone, users: env.collaborators, now: Date.now(), weekStart: me.data?.week_start === 1 ? 1 : 0 });

  const draft = { name, description: "", kind: plan.kind, inverseName: "" };
  const nameIssue = validateDraft(draft, kindCtx).find((i) => i.field === "name");
  // The value is checked against the type before anything is made, so a refusal leaves nothing behind.
  const valueIssue = useMemo(() => {
    if (!value.trim() || noValue || needsSetup(plan.kind.type)) return null;
    const res = valueFor(probeField(plan.kind), value, { timeZone: env.timeZone, users: env.collaborators, now: Date.now(), weekStart: 0 });
    return res.ok ? null : res.error;
  }, [value, plan.kind, noValue, env.timeZone, env.collaborators]);

  const close = () => {
    setOpen(false);
    setName("");
    setValue("");
    setChosen(null);
    setSubmitted(false);
    setError(null);
    // The box came from this button; it is where the keyboard picks up again.
    requestAnimationFrame(() => opener.current?.focus());
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setSubmitted(true);
    if (nameIssue) {
      nameInput.current?.focus();
      return;
    }
    if (needsSetup(plan.kind.type)) {
      onSetup(name.trim(), plan.kind.type);
      close();
      return;
    }
    if (valueIssue) return;
    setBusy(true);
    setError(null);
    try {
      const field: Field = await schemaApi.createField(table.id, toCreateField(draft));
      await qc.invalidateQueries({ queryKey: keys.base(schema.id) });
      const cell = noValue ? null : valueFor(field, value, valueCtx());
      if (cell && !cell.ok) toast.toast({ title: `“${field.name}” was added, but its value was not set`, description: cell.error, variant: "error" });
      else if (cell?.ok && cell.value !== null) save.onSave(field, { json: cell.value });
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Escape cancels the box and only the box: the page behind it would otherwise leave for the collection.
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || picking) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  if (!open) {
    return (
      <Button ref={opener} id="add-property" variant="ghost" size="sm" className="mt-2 -ml-2 self-start text-muted hover:text-fg" onClick={() => setOpen(true)}>
        <Icon icon={Plus} /> Add property
      </Button>
    );
  }

  const typePicker = (
    <PropertyTypeList
      value={plan.kind.type}
      onChange={(t) => {
        setChosen(t);
        setPicking(false);
      }}
    />
  );
  const changeButton = (
    <Button ref={changeType} variant="ghost" size="sm" aria-haspopup="listbox" aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
      Change type
    </Button>
  );

  return (
    <form ref={form} role="group" aria-label="Add property" data-escape-cancels onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown} className="mt-3 flex flex-col gap-3 rounded-lg border border-line bg-surface p-3 max-md:rounded-xl max-md:p-4">
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <Labelled label="Name" error={submitted ? nameIssue?.message : undefined}>
          {(c) => <Input {...c} ref={nameInput} autoFocus maxLength={255} className="max-md:h-control-touch max-md:text-read-phone" value={name} onChange={(e) => setName(e.target.value)} />}
        </Labelled>
        <Labelled label="Value" error={submitted ? valueIssue : undefined}>
          {(c) => (
            <Input
              {...c}
              aria-describedby={[c["aria-describedby"], hintId].filter(Boolean).join(" ")}
              disabled={!!noValue}
              placeholder={noValue ?? undefined}
              className="max-md:h-control-touch max-md:text-read-phone"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Labelled>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span id={hintId} aria-live="polite" aria-atomic className="inline-flex">
          <CaptureChip static>{chipText(plan, value)}</CaptureChip>
        </span>
        {desktop ? (
          <Popover open={picking} onOpenChange={setPicking}>
            <PopoverTrigger asChild>{changeButton}</PopoverTrigger>
            <PopoverContent className="w-96 max-h-96 p-2">{typePicker}</PopoverContent>
          </Popover>
        ) : (
          <>
            {changeButton}
            <Sheet open={picking} onOpenChange={setPicking} title="Property type" doneLabel="Close">
              {typePicker}
            </Sheet>
          </>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={busy}>
          Add property
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-label text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
