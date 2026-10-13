/**
 * Field values of a create_record / update_record action. Each row is one field of the target
 * table, either a typed value (the same editor the expanded record uses, `FieldEditor` with
 * `variant="form"`) or a text template (`{{trigger.record.fields.Name}}`, plain text the server
 * converts like Airtable's typecast). Text-like fields and links are always templates.
 */
import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import type { Field, JsonValue as Json, Table } from "@/api/types";
import { EditorEnvProvider, type EditValue, type EditorEnv } from "@/components/record/editors/env";
import { FieldEditor } from "@/components/record/editors/FieldEditor";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { IconButton } from "@/components/ui/icon-button";
import { Select } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { isComputed, selectChoicesOf, stringItems } from "@/lib/cells/kinds";
import { parseText } from "@/lib/cells/parse";
import { toWire } from "@/lib/cells/wire";
import { atLeast } from "@/lib/roles";
import { useAutomationEnv } from "./context";
import { TemplateInput } from "./TemplateInput";
import { hasTemplate, type TemplateContext } from "./templates";

/** Types whose natural editor is a text box, so a template fits directly. */
const TEXT_TYPES = new Set<Field["type"]>(["single_line_text", "long_text", "email", "url", "phone", "barcode"]);

/** Fields an action may set: no computed fields, and no attachments (they need an upload). */
export function writableFields(table: Table | undefined): Field[] {
  return (table?.fields ?? []).filter((f) => !isComputed(f) && f.type !== "attachment");
}

/** A typed editor cannot show a template, or a name that is not one of a select's choice ids. */
export function valueMode(field: Field, value: unknown): "value" | "template" {
  if (TEXT_TYPES.has(field.type) || field.type === "link") return "template";
  if (hasTemplate(value)) return "template";
  if ((field.type === "single_select" || field.type === "multiple_select") && value !== null && value !== undefined && value !== "") {
    const ids = new Set(selectChoicesOf(field).map((c) => c.id));
    if (!stringItems(value).every((v) => ids.has(v))) return "template";
  }
  return "value";
}

export function emptyValue(field: Field): Json {
  return TEXT_TYPES.has(field.type) || field.type === "link" ? "" : null;
}

export function templateText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export interface ValuesEditorProps {
  table: Table | undefined;
  values: Record<string, Json>;
  onChange: (values: Record<string, Json>) => void;
  ctx: TemplateContext;
  error?: string;
}

export function ValuesEditor({ table, values, onChange, ctx, error }: ValuesEditorProps) {
  const env = useAutomationEnv();
  const editorEnv = useMemo<EditorEnv>(
    () => ({
      baseId: env.schema.id,
      tableId: table?.id ?? "",
      collaborators: env.collaborators,
      timeZone: env.timeZone,
      canCreateOptions: atLeast(env.schema.role, "creator"),
      format: { timeZone: env.timeZone, userName: (id) => env.collaborators.find((c) => c.id === id)?.name },
      currentUserId: env.currentUserId,
    }),
    [env, table?.id],
  );

  if (!table) return <p className="text-[0.8125rem] text-danger">The table no longer exists. Choose another one.</p>;
  const fields = writableFields(table);
  const byId = new Map(table.fields.map((f) => [f.id, f] as const));
  const rows = Object.keys(values);
  const unused = fields.filter((f) => !(f.id in values));

  const set = (fieldId: string, value: Json) => onChange({ ...values, [fieldId]: value });
  const remove = (fieldId: string) => {
    const { [fieldId]: _gone, ...rest } = values;
    onChange(rest);
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && <p className="text-[0.8125rem] text-muted">No field values yet. Fields you leave out are left empty (create) or unchanged (update).</p>}
      <EditorEnvProvider value={editorEnv}>
        <ul className="flex flex-col gap-3">
          {rows.map((fieldId) => {
            const field = byId.get(fieldId);
            return (
              <li key={fieldId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:gap-3">
                {field ? <ValueRow field={field} value={values[fieldId] ?? null} onChange={(v) => set(fieldId, v)} ctx={ctx} timeZone={env.timeZone} collaborators={env.collaborators} /> : <MissingField fieldId={fieldId} />}
                <IconButton label={`Remove ${field?.name ?? "deleted field"}`} size="sm" onClick={() => remove(fieldId)} className="self-start">
                  <Trash2 aria-hidden className="size-4" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      </EditorEnvProvider>
      <div className="max-w-xs">
        <Select
          aria-label="Add a field"
          value=""
          disabled={unused.length === 0}
          onChange={(e) => {
            const f = fields.find((x) => x.id === e.target.value);
            if (f) set(f.id, emptyValue(f));
          }}
        >
          <option value="">{unused.length === 0 ? "All fields added" : "Add a field…"}</option>
          {unused.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function MissingField({ fieldId }: { fieldId: string }) {
  return (
    <p className="text-[0.8125rem] text-danger sm:col-span-2">
      The field {fieldId} no longer exists in this table. Remove this row.
    </p>
  );
}

function ValueRow({ field, value, onChange, ctx, timeZone, collaborators }: { field: Field; value: Json; onChange: (v: Json) => void; ctx: TemplateContext; timeZone: string; collaborators: AutomationEnvCollaborators }) {
  const [mode, setMode] = useState<"value" | "template">(() => valueMode(field, value));
  const [error, setError] = useState<string | null>(null);
  const labelId = `value-${field.id}`;
  const switchable = !TEXT_TYPES.has(field.type) && field.type !== "link";

  const commit = (edit: EditValue) => {
    let after: unknown = edit.json ?? null;
    if (edit.text !== undefined) {
      const res = parseText(field, edit.text, { timeZone, users: collaborators });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      after = res.value;
    }
    setError(null);
    onChange(toWire(field, after) as Json);
  };

  const pick = (next: "value" | "template") => {
    if (next === mode) return;
    setMode(next);
    setError(null);
    onChange(next === "template" ? (templateText(value) as Json) : emptyValue(field));
  };

  return (
    <>
      <div className="col-span-2 flex min-w-0 items-start gap-1.5 sm:col-span-1 sm:pt-1.5">
        <FieldTypeIcon type={field.type} className="mt-0.5" />
        <span id={labelId} className="truncate text-[0.8125rem] font-medium" title={field.name}>
          {field.name}
        </span>
      </div>
      <div className="min-w-0">
        {mode === "template" ? (
          <TemplateInput value={templateText(value)} onChange={(v) => onChange(v)} ctx={ctx} label={field.name} multiline={field.type === "long_text"} rows={3} placeholder={templatePlaceholder(field)} />
        ) : (
          <FieldEditor key={`${field.id}:${JSON.stringify(value)}`} field={field} value={value} variant="form" labelledBy={labelId} onCommit={commit} onCancel={() => {}} />
        )}
        {error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        )}
        {switchable && (
          <div className="mt-1 flex gap-1 text-xs" role="group" aria-label={`${field.name} input mode`}>
            {(["value", "template"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => pick(m)}
                className={cn("rounded px-1.5 py-0.5", mode === m ? "bg-primary-soft text-primary" : "text-muted hover:bg-hover")}
              >
                {m === "value" ? "Fixed value" : "Template"}
              </button>
            ))}
          </div>
        )}
        {mode === "template" && field.type === "link" && <p className="mt-1 text-xs text-muted">A record id, the text of its first field, or a template such as {"{{steps.1.record_id}}"}.</p>}
      </div>
    </>
  );
}

type AutomationEnvCollaborators = ReturnType<typeof useAutomationEnv>["collaborators"];

function templatePlaceholder(field: Field): string | undefined {
  switch (field.type) {
    case "single_line_text":
    case "long_text":
      return "Text, with {{placeholders}}";
    case "email":
      return "name@example.com or a placeholder";
    default:
      return undefined;
  }
}
