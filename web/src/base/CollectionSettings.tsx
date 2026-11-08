/**
 * A collection's settings (COL-10), opened from the "…" beside its title, for creators: its name, color,
 * description, what one record is called, and the properties that play a part: the title (the primary
 * property, which can be changed here for the first time), the page, the date Home shows the records by, and
 * the checkbox that marks one done. A dialog on a desktop and a full-screen sheet on a phone (`Dialog`).
 *
 * Everything is saved with Save, in the same calls an agent makes: `POST /api/tables/{id}/primary-field`,
 * `POST /api/tables/{id}/body-field` and `PATCH /api/tables/{id}` (MCP `set_primary_field`, `set_page_field`
 * and `update_table_settings`).
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { errorMessage } from "@/api/client";
import { keys } from "@/api/keys";
import type { Field, Table, UpdateTable } from "@/api/types";
import { ColorField } from "@/components/ColorField";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FIELD_TYPE_LABELS } from "@/components/ui/field-type-icon";
import { Field as Labelled, Input, Select, Textarea } from "@/components/ui/input";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { canBePrimary, resultTypeOf, unwrapResult } from "@/lib/cells/kinds";
import type { ChoiceColor } from "@/lib/colors";

const NO_PROPERTY = "";

/** A property Home can order the collection's records by: a date, created or modified time, or a formula or rollup that gives a date. */
export function isHomeDateProperty(field: Field): boolean {
  if (field.type === "date" || field.type === "created_time" || field.type === "last_modified_time") return true;
  if (field.type !== "formula" && field.type !== "rollup") return false;
  const result = resultTypeOf(field);
  if (!result) return false;
  const { array, item } = unwrapResult(result);
  return !array && (item === "date" || item === "date_time");
}

/** Why a property cannot be the title, or null when it can. */
export function whyNotTitle(field: Field): string | null {
  return canBePrimary(field.type) ? null : `${FIELD_TYPE_LABELS[field.type]} properties can't be the title`;
}

export interface Draft {
  name: string;
  color: string;
  description: string;
  noun: string;
  title: string;
  page: string;
  homeDate: string;
  done: string;
}

function draftOf(table: Table): Draft {
  return {
    name: table.name,
    color: table.color,
    description: table.description ?? "",
    noun: table.record_noun,
    title: table.primary_field_id,
    page: table.body_field_id ?? NO_PROPERTY,
    homeDate: table.home_date_field_id ?? NO_PROPERTY,
    done: table.done_field_id ?? NO_PROPERTY,
  };
}

/** The calls Save makes for what changed: the title first (it clears a setting that names it), then the page, then the rest in one. */
export function settingsPatch(table: Table, d: Draft): { title: string | null; page: { field_id: string | null } | null; patch: UpdateTable | null } {
  const patch: UpdateTable = {};
  if (d.name.trim() !== table.name) patch.name = d.name.trim();
  if (d.color !== table.color) patch.color = d.color;
  if (d.description.trim() !== (table.description ?? "")) patch.description = d.description.trim();
  if (d.noun.trim() !== table.record_noun) patch.record_noun = d.noun.trim();
  if (d.homeDate !== (table.home_date_field_id ?? NO_PROPERTY)) patch.home_date_field_id = d.homeDate || null;
  if (d.done !== (table.done_field_id ?? NO_PROPERTY)) patch.done_field_id = d.done || null;
  return {
    title: d.title !== table.primary_field_id ? d.title : null,
    page: d.page !== (table.body_field_id ?? NO_PROPERTY) ? { field_id: d.page || null } : null,
    patch: Object.keys(patch).length > 0 ? patch : null,
  };
}

export interface CollectionSettingsProps {
  table: Table;
  baseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A property chosen from the collection's properties, with an option for none. */
function PropertySelect({ label, hint, value, onChange, none, fields, disabled }: { label: string; hint: ReactNode; value: string; onChange: (id: string) => void; none?: string; fields: Field[]; disabled?: (f: Field) => string | null }) {
  return (
    <Labelled label={label} hint={hint}>
      {(ctl) => (
        <Select {...ctl} value={value} onChange={(e) => onChange(e.target.value)}>
          {none !== undefined && <option value={NO_PROPERTY}>{none}</option>}
          {fields.map((f) => {
            const why = disabled?.(f) ?? null;
            return (
              <option key={f.id} value={f.id} disabled={!!why}>
                {why ? `${f.name} (${why})` : f.name}
              </option>
            );
          })}
        </Select>
      )}
    </Labelled>
  );
}

const FORM_ID = "collection-settings-form";

export function CollectionSettings({ table, baseId, open, onOpenChange }: CollectionSettingsProps) {
  const qc = useQueryClient();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const nameField = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => draftOf(table));
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  // Each opening starts from what the collection is now; typing is not undone by a refresh that arrives while it is open.
  useEffect(() => {
    if (!open) return;
    setDraft(draftOf(table));
    setError(null);
  }, [open]);

  const save = useMutation({
    mutationFn: async () => {
      const { title, page, patch } = settingsPatch(table, draft);
      if (title) await api.tables.setPrimaryField(table.id, title);
      if (page) await api.tables.setBodyField(table.id, page);
      if (patch) await api.tables.update(table.id, patch);
    },
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: keys.base(baseId) }), qc.invalidateQueries({ queryKey: keys.workspaces })]);
      onOpenChange(false);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim()) return;
    setError(null);
    save.mutate();
  };

  const noun = draft.noun.trim() || "record";
  const pages = table.fields.filter((f) => f.type === "rich_text" && f.id !== draft.title);
  const dates = table.fields.filter(isHomeDateProperty);
  const checks = table.fields.filter((f) => f.type === "checkbox");
  const changes = settingsPatch(table, draft);
  const changed = !!changes.title || !!changes.page || !!changes.patch;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Collection settings"
      description={table.name}
      size="md"
      // The name is the first thing to change on a desktop; on a phone focusing it would raise the keyboard over the sheet.
      onOpenAutoFocus={(e) => {
        if (!desktop) return;
        e.preventDefault();
        nameField.current?.focus();
      }}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} variant="primary" loading={save.isPending} disabled={!draft.name.trim() || !changed}>
            Save
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} className="flex flex-col gap-4">
        <Labelled label="Name">
          {(ctl) => <Input {...ctl} ref={nameField} value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={255} required />}
        </Labelled>
        <ColorField value={draft.color} onChange={(c: ChoiceColor) => set("color", c)} />
        <Labelled label="Description" hint="One line under the title.">
          {(ctl) => <Textarea {...ctl} rows={2} value={draft.description} onChange={(e) => set("description", e.target.value)} maxLength={1000} />}
        </Labelled>
        <Labelled label="Record name" hint={`What one record is called, in the singular. The button reads "New ${noun}". Leave it empty for "record".`}>
          {(ctl) => <Input {...ctl} value={draft.noun} onChange={(e) => set("noun", e.target.value)} maxLength={40} placeholder="record" />}
        </Labelled>
        <PropertySelect label="Title property" hint="Names each record. It is the first column and what links show." value={draft.title} onChange={(id) => set("title", id)} fields={table.fields} disabled={whyNotTitle} />
        <PropertySelect label="Page property" hint="The rich text property that holds each record's page." value={draft.page} onChange={(id) => set("page", id)} none="None" fields={pages} />
        <PropertySelect label="Show on Home by" hint="Records dated in this property appear under Due soon on Home." value={draft.homeDate} onChange={(id) => set("homeDate", id)} none="Not shown on Home" fields={dates} />
        <PropertySelect label="Done property" hint="A checked box takes a record off Due soon." value={draft.done} onChange={(id) => set("done", id)} none="None" fields={checks} />
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Dialog>
  );
}
