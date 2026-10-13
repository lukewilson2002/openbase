/** One editor per action type. Each edits its slice of the `Action` union and reports a whole new action. */
import { useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Action } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconButton } from "@/components/ui/icon-button";
import { Field, Input, Select } from "@/components/ui/input";
import { Notice } from "@/components/layouts";
import { useAutomationEnv } from "./context";
import { TemplateField, TemplateInput } from "./TemplateInput";
import type { TemplateContext } from "./templates";
import { ValuesEditor } from "./ValuesEditor";

type Of<T extends Action["type"]> = Extract<Action, { type: T }>;

export interface ActionEditorProps<T extends Action["type"]> {
  action: Of<T>;
  onChange: (action: Of<T>) => void;
  ctx: TemplateContext;
  /** Server message for this action (without the "action N:" prefix). */
  error?: string;
}

function TableSelect({ label, value, onChange }: { label: string; value: string; onChange: (id: string) => void }) {
  const { schema } = useAutomationEnv();
  const known = schema.tables.some((t) => t.id === value);
  return (
    <Field label={label} className="max-w-xs">
      {(ctl) => (
        <Select {...ctl} value={value} onChange={(e) => onChange(e.target.value)}>
          {!known && <option value={value}>(deleted table)</option>}
          {schema.tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

export function CreateRecordEditor({ action, onChange, ctx, error }: ActionEditorProps<"create_record">) {
  const { schema } = useAutomationEnv();
  const table = schema.tables.find((t) => t.id === action.table_id);
  return (
    <div className="flex flex-col gap-4">
      <TableSelect label="Table" value={action.table_id} onChange={(id) => onChange({ ...action, table_id: id, values: {} })} />
      <div>
        <h4 className="mb-2 text-[0.8125rem] font-medium">Field values</h4>
        <ValuesEditor table={table} values={action.values} onChange={(values) => onChange({ ...action, values })} ctx={ctx} error={error} />
      </div>
    </div>
  );
}

export function UpdateRecordEditor({ action, onChange, ctx, error }: ActionEditorProps<"update_record">) {
  const { schema } = useAutomationEnv();
  const table = schema.tables.find((t) => t.id === action.table_id);
  return (
    <div className="flex flex-col gap-4">
      <TableSelect label="Table" value={action.table_id} onChange={(id) => onChange({ ...action, table_id: id, values: {} })} />
      <TemplateField
        label="Record id"
        value={action.record_id}
        onChange={(record_id) => onChange({ ...action, record_id })}
        ctx={ctx}
        mono
        placeholder="{{trigger.record.id}}"
        hint="The id of the record to change, usually a placeholder such as {{trigger.record.id}} or {{steps.1.record_id}}."
      />
      <div>
        <h4 className="mb-2 text-[0.8125rem] font-medium">Field values</h4>
        <ValuesEditor table={table} values={action.values} onChange={(values) => onChange({ ...action, values })} ctx={ctx} error={error} />
      </div>
    </div>
  );
}

export function SendEmailEditor({ action, onChange, ctx }: ActionEditorProps<"send_email">) {
  const { emailEnabled } = useAutomationEnv();
  return (
    <div className="flex flex-col gap-4">
      {!emailEnabled && (
        <Notice tone="warning">
          Email is not configured on this server, so this action cannot be saved. An administrator can enable it by setting <code>OPENGRID_SMTP_HOST</code> (see the self-hosting guide).
        </Notice>
      )}
      <TemplateField label="To" value={action.to} onChange={(to) => onChange({ ...action, to })} ctx={ctx} placeholder="name@example.com, other@example.com" hint="One address or a comma-separated list of up to 10. Placeholders are allowed." />
      <TemplateField label="Subject" value={action.subject} onChange={(subject) => onChange({ ...action, subject })} ctx={ctx} />
      <TemplateField label="Body" value={action.body} onChange={(body) => onChange({ ...action, body })} ctx={ctx} multiline rows={6} hint="Plain text." />
    </div>
  );
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function HttpRequestEditor({ action, onChange, ctx }: ActionEditorProps<"http_request">) {
  const bodyAllowed = action.method !== "GET";
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <Field label="Method">
          {(ctl) => (
            <Select {...ctl} value={action.method} onChange={(e) => onChange({ ...action, method: e.target.value as Of<"http_request">["method"] })}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <TemplateField label="URL" value={action.url} onChange={(url) => onChange({ ...action, url })} ctx={ctx} mono placeholder="https://example.com/hook" hint="Only http and https. Private and local addresses are refused unless the server allows them." />
      </div>
      <HeadersEditor headers={action.headers} onChange={(headers) => onChange({ ...action, headers })} ctx={ctx} />
      {bodyAllowed ? (
        <TemplateField
          label="Body"
          value={action.body ?? ""}
          onChange={(body) => onChange({ ...action, body })}
          ctx={ctx}
          multiline
          rows={5}
          mono
          hint="Sent as is. Add a Content-Type header such as application/json; placeholders are escaped for JSON bodies."
        />
      ) : (
        <p className="text-xs text-muted">A GET request has no body.</p>
      )}
    </div>
  );
}

interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

let rowId = 0;

/** Ordered key/value rows; blank names are kept in the editor but not sent. */
function HeadersEditor({ headers, onChange, ctx }: { headers: Record<string, string>; onChange: (h: Record<string, string>) => void; ctx: TemplateContext }) {
  const [rows, setRows] = useState<HeaderRow[]>(() => Object.entries(headers).map(([name, value]) => ({ id: ++rowId, name, value })));
  const update = (next: HeaderRow[]) => {
    setRows(next);
    const out: Record<string, string> = {};
    for (const r of next) if (r.name.trim()) out[r.name.trim()] = r.value;
    onChange(out);
  };
  const heading = useId();
  return (
    <div role="group" aria-labelledby={heading}>
      <h4 id={heading} className="mb-1 text-[0.8125rem] font-medium">
        Headers
      </h4>
      {rows.length === 0 && <p className="mb-2 text-xs text-muted">No headers. Add Authorization or Content-Type if the receiver needs them.</p>}
      <ul className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <li key={r.id} className="grid gap-1.5 sm:grid-cols-[12rem_minmax(0,1fr)_auto]">
            <Input aria-label={`Header ${i + 1} name`} value={r.name} placeholder="Authorization" onChange={(e) => update(rows.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))} />
            <TemplateInput label={`header ${i + 1} value`} value={r.value} placeholder="Bearer …" onChange={(value) => update(rows.map((x) => (x.id === r.id ? { ...x, value } : x)))} ctx={ctx} />
            <IconButton label={`Remove header ${i + 1}`} size="sm" className="self-start" onClick={() => update(rows.filter((x) => x.id !== r.id))}>
              <Trash2 aria-hidden className="size-4" />
            </IconButton>
          </li>
        ))}
      </ul>
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => setRows([...rows, { id: ++rowId, name: "", value: "" }])}>
        <Plus aria-hidden className="size-4" /> Add header
      </Button>
    </div>
  );
}

export function NotifyEditor({ action, onChange, ctx }: ActionEditorProps<"notify">) {
  const { collaborators } = useAutomationEnv();
  const selected = new Set(action.user_ids);
  const toggle = (id: string, on: boolean) => onChange({ ...action, user_ids: on ? [...action.user_ids, id] : action.user_ids.filter((u) => u !== id) });
  const unknown = action.user_ids.filter((id) => !collaborators.some((c) => c.id === id));
  return (
    <div className="flex flex-col gap-4">
      <fieldset>
        <legend className="mb-1 text-[0.8125rem] font-medium">Who to notify</legend>
        {collaborators.length === 0 ? (
          <p className="text-xs text-muted">Nobody else has access to this base yet. Share the base to notify teammates.</p>
        ) : (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {collaborators.map((c) => (
              <li key={c.id}>
                <Checkbox checked={selected.has(c.id)} onCheckedChange={(on) => toggle(c.id, on)} label={<span>{c.name} <span className="text-muted">{c.email}</span></span>} />
              </li>
            ))}
          </ul>
        )}
        {unknown.map((id) => (
          <div key={id} className="mt-1.5">
            <Checkbox checked onCheckedChange={() => toggle(id, false)} label={<span className="text-danger">{id} (no longer has access, untick to remove)</span>} />
          </div>
        ))}
      </fieldset>
      <TemplateField label="Message" value={action.message} onChange={(message) => onChange({ ...action, message })} ctx={ctx} multiline rows={3} hint="Shown in the notification bell. Up to 2,000 characters." />
    </div>
  );
}
