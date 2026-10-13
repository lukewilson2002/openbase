/** The trigger section: pick what starts the automation and configure it. */
import type { ReactNode } from "react";
import type { Trigger } from "@/api/types";
import { Checkbox } from "@/components/ui/checkbox";
import { EntitySelect } from "@/components/ui/entity-select";
import { Field, Select } from "@/components/ui/input";
import { FilterBuilder } from "@/components/viewbar/FilterBuilder";
import { isComputed } from "@/lib/cells/kinds";
import { useAutomationEnv } from "./context";
import { TRIGGER_HINTS, TRIGGER_LABELS, TRIGGER_TYPES, formViews, newTrigger, triggerTable, triggerUnavailableReason, withTriggerTable, type TriggerType } from "./model";
import { ScheduleEditor } from "./ScheduleEditor";
import { WebhookPanel, type WebhookPanelProps } from "./WebhookPanel";

export interface TriggerEditorProps {
  trigger: Trigger;
  onChange: (trigger: Trigger) => void;
  webhook: WebhookPanelProps;
  nextRunAt?: number | null;
  nextRunNote?: string;
  /** Server message about the trigger (anything not prefixed "action N:"). */
  error?: string;
}

export function TriggerEditor({ trigger, onChange, webhook, nextRunAt, nextRunNote, error }: TriggerEditorProps) {
  const { schema, timeZone } = useAutomationEnv();
  return (
    <div className="flex flex-col gap-4">
      <Field label="When this happens" hint={TRIGGER_HINTS[trigger.type]} className="max-w-md">
        {(ctl) => (
          <Select
            {...ctl}
            value={trigger.type}
            onChange={(e) => {
              const type = e.target.value as TriggerType;
              if (type === trigger.type) return;
              const next = newTrigger(type, schema, timeZone);
              if (next) onChange(next);
            }}
          >
            {TRIGGER_TYPES.map((t) => {
              const why = triggerUnavailableReason(t, schema);
              return (
                <option key={t} value={t} disabled={!!why && t !== trigger.type}>
                  {TRIGGER_LABELS[t]}
                  {why ? ` (${why.toLowerCase()})` : ""}
                </option>
              );
            })}
          </Select>
        )}
      </Field>
      <TriggerFields trigger={trigger} onChange={onChange} webhook={webhook} nextRunAt={nextRunAt} nextRunNote={nextRunNote} error={error} />
    </div>
  );
}

function TriggerFields({ trigger, onChange, webhook, nextRunAt, nextRunNote, error }: TriggerEditorProps): ReactNode {
  const { schema, collaborators } = useAutomationEnv();
  const tableSelect = (tableId: string) => (
    <Field label="Table" className="max-w-md">
      {(ctl) => (
        <EntitySelect
          {...ctl}
          value={tableId}
          onValueChange={(id) => onChange(withTriggerTable(trigger, id))}
          options={[...(schema.tables.some((t) => t.id === tableId) ? [] : [{ value: tableId, label: "(deleted table)" }]), ...schema.tables.map((t) => ({ value: t.id, label: t.name, icon: t.icon }))]}
        />
      )}
    </Field>
  );

  switch (trigger.type) {
    case "record_created":
      return tableSelect(trigger.table_id);
    case "record_updated": {
      const table = triggerTable(trigger, schema);
      const watchable = (table?.fields ?? []).filter((f) => !isComputed(f));
      const chosen = new Set(trigger.field_ids);
      return (
        <>
          {tableSelect(trigger.table_id)}
          <fieldset>
            <legend className="mb-1 text-[0.8125rem] font-medium">Watched fields</legend>
            <p className="mb-2 text-xs text-muted">{chosen.size === 0 ? "Any field: the automation runs for every edit." : "Runs when at least one of the ticked fields changes."}</p>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {watchable.map((f) => (
                <li key={f.id}>
                  <Checkbox
                    checked={chosen.has(f.id)}
                    label={f.name}
                    onCheckedChange={(on) => onChange({ ...trigger, field_ids: on ? [...trigger.field_ids, f.id] : trigger.field_ids.filter((id) => id !== f.id) })}
                  />
                </li>
              ))}
            </ul>
            {watchable.length === 0 && <p className="text-xs text-muted">This table has no editable fields.</p>}
          </fieldset>
        </>
      );
    }
    case "record_matches": {
      const table = triggerTable(trigger, schema);
      return (
        <>
          {tableSelect(trigger.table_id)}
          <div>
            <h4 className="mb-1 text-[0.8125rem] font-medium">Conditions</h4>
            <p className="mb-2 text-xs text-muted">Runs when a record starts matching: created matching, or edited from not matching to matching.</p>
            <FilterBuilder
              value={trigger.filter.items.length > 0 ? trigger.filter : null}
              onChange={(filter) => onChange({ ...trigger, filter: filter ?? { conjunction: "and", items: [] } })}
              fields={table?.fields ?? []}
              collaborators={collaborators}
              tables={schema.tables}
              label="Trigger condition"
              emptyText="No conditions yet: every record matches. Add a condition."
            />
          </div>
        </>
      );
    }
    case "form_submitted": {
      const forms = formViews(schema);
      const known = forms.some((f) => f.view.id === trigger.view_id);
      return (
        <Field label="Form" className="max-w-md" hint={forms.length === 0 ? "This base has no form views. Create one from a table's view sidebar." : undefined}>
          {(ctl) => (
            <EntitySelect
              {...ctl}
              value={trigger.view_id}
              onValueChange={(id) => onChange({ type: "form_submitted", view_id: id })}
              options={[...(known ? [] : [{ value: trigger.view_id, label: "(deleted form)" }]), ...forms.map(({ table, view }) => ({ value: view.id, label: `${table.name} / ${view.name}`, icon: table.icon }))]}
            />
          )}
        </Field>
      );
    }
    case "schedule":
      return (
        <ScheduleEditor
          cron={trigger.cron}
          timezone={trigger.timezone}
          onChange={({ cron, timezone }) => onChange({ type: "schedule", cron, timezone })}
          nextRunAt={nextRunAt}
          nextRunNote={nextRunNote}
          error={error}
        />
      );
    case "webhook":
      return <WebhookPanel {...webhook} />;
  }
}
