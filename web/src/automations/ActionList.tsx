/** The ordered list of actions: cards with reorder / remove, an optional condition each, and the add menu. */
import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Bell, ChevronDown, ChevronRight, FilePlus2, Globe, Mail, Plus, RefreshCw, Trash2, type LucideIcon } from "lucide-react";
import type { Action, ActionStep, Field, Filter, Trigger } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { FilterBuilder } from "@/components/viewbar/FilterBuilder";
import { cn } from "@/lib/cn";
import { CreateRecordEditor, HttpRequestEditor, NotifyEditor, SendEmailEditor, UpdateRecordEditor } from "./ActionEditors";
import { useAutomationEnv } from "./context";
import { ACTION_HINTS, ACTION_LABELS, ACTION_TYPES, MAX_ACTIONS, actionSummary, triggerShape, triggerTable, withCondition, type ActionType, type DraftStep } from "./model";
import type { TemplateContext } from "./templates";

export const ACTION_ICONS: Record<ActionType, LucideIcon> = {
  create_record: FilePlus2,
  update_record: RefreshCw,
  send_email: Mail,
  http_request: Globe,
  notify: Bell,
};

export interface ActionListProps {
  trigger: Trigger;
  steps: DraftStep[];
  /** Server messages per action index (0-based). */
  errors: Record<number, string>;
  onChange: (steps: DraftStep[]) => void;
  onAdd: (type: ActionType) => void;
}

export function ActionList({ trigger, steps, errors, onChange, onAdd }: ActionListProps) {
  const env = useAutomationEnv();
  const table = triggerTable(trigger, env.schema);
  const shape = triggerShape(trigger);

  const patch = (i: number, step: ActionStep) => onChange(steps.map((s, k) => (k === i ? { ...s, step } : s)));
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    const next = steps.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const remove = (i: number) => onChange(steps.filter((_, k) => k !== i));

  return (
    <div className="flex flex-col gap-3">
      {steps.length === 0 ? (
        <div className="rounded-md border border-dashed border-line-strong px-4 py-6 text-center">
          <p className="text-[0.8125rem] font-medium">No actions yet</p>
          <p className="mt-1 text-xs text-muted">An automation needs at least one action before it can be turned on. Add what should happen when the trigger fires.</p>
        </div>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Actions">
          {steps.map((s, i) => {
            const ctx: TemplateContext = { shape, fields: table?.fields ?? [], earlier: steps.slice(0, i).map((x) => x.step) };
            return (
              <ActionCard
                key={s.key}
                index={i}
                count={steps.length}
                step={s.step}
                ctx={ctx}
                error={errors[i]}
                hasRecord={table !== null}
                fields={table?.fields ?? []}
                onChange={(step) => patch(i, step)}
                onMove={(by) => move(i, by)}
                onRemove={() => remove(i)}
              />
            );
          })}
        </ol>
      )}
      <AddActionMenu count={steps.length} onAdd={onAdd} />
    </div>
  );
}

function AddActionMenu({ count, onAdd }: { count: number; onAdd: (type: ActionType) => void }) {
  const { emailEnabled } = useAutomationEnv();
  const full = count >= MAX_ACTIONS;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={full}>
            <Plus aria-hidden className="size-4" /> Add action
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          {ACTION_TYPES.map((t) => {
            const Icon = ACTION_ICONS[t];
            const blocked = t === "send_email" && !emailEnabled;
            return (
              <DropdownMenuItem key={t} disabled={blocked} onSelect={() => onAdd(t)} className="items-start">
                <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                <span className="flex flex-col">
                  <span className="font-medium">{ACTION_LABELS[t]}</span>
                  <span className="text-xs text-muted">{blocked ? "Unavailable: email is not configured on this server" : ACTION_HINTS[t]}</span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="text-xs text-muted">
        {count} of {MAX_ACTIONS} actions{full ? ": the limit is reached" : ""}
      </span>
    </div>
  );
}

interface ActionCardProps {
  index: number;
  count: number;
  step: ActionStep;
  ctx: TemplateContext;
  error?: string;
  hasRecord: boolean;
  fields: readonly Field[];
  onChange: (step: ActionStep) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}

function ActionCard({ index, count, step, ctx, error, hasRecord, fields, onChange, onMove, onRemove }: ActionCardProps) {
  const env = useAutomationEnv();
  const [open, setOpen] = useState(true);
  const Icon = ACTION_ICONS[step.type];
  const label = ACTION_LABELS[step.type];
  const summary = actionSummary(step, env.schema);
  const bodyId = `action-${index}-body`;

  const setAction = (action: Action) => onChange({ ...action, ...(step.condition ? { condition: step.condition } : {}) } as ActionStep);

  let editor: ReactNode;
  switch (step.type) {
    case "create_record":
      editor = <CreateRecordEditor action={step} onChange={setAction} ctx={ctx} error={error} />;
      break;
    case "update_record":
      editor = <UpdateRecordEditor action={step} onChange={setAction} ctx={ctx} error={error} />;
      break;
    case "send_email":
      editor = <SendEmailEditor action={step} onChange={setAction} ctx={ctx} />;
      break;
    case "http_request":
      editor = <HttpRequestEditor action={step} onChange={setAction} ctx={ctx} />;
      break;
    case "notify":
      editor = <NotifyEditor action={step} onChange={setAction} ctx={ctx} />;
      break;
  }
  // Create / update show their error next to the values; everything else gets it here.
  const errorInEditor = step.type === "create_record" || step.type === "update_record";

  return (
    <li className={cn("rounded-lg border bg-surface", error ? "border-danger" : "border-line")} aria-label={`Action ${index + 1}: ${label}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" aria-expanded={open} aria-controls={bodyId} aria-label={`${open ? "Collapse" : "Expand"} action ${index + 1}`} onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 rounded text-left">
          {open ? <ChevronDown aria-hidden className="size-4 shrink-0 text-muted" /> : <ChevronRight aria-hidden className="size-4 shrink-0 text-muted" />}
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-semibold" aria-hidden>
            {index + 1}
          </span>
          <Icon aria-hidden className="size-4 shrink-0 text-muted" />
          <span className="shrink-0 text-[0.8125rem] font-medium">{label}</span>
          <span className="min-w-0 truncate text-xs text-muted">{summary}</span>
        </button>
        <IconButton label={`Move action ${index + 1} up`} size="sm" disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp aria-hidden className="size-4" />
        </IconButton>
        <IconButton label={`Move action ${index + 1} down`} size="sm" disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown aria-hidden className="size-4" />
        </IconButton>
        <IconButton label={`Remove action ${index + 1}`} size="sm" onClick={onRemove}>
          <Trash2 aria-hidden className="size-4" />
        </IconButton>
      </div>
      <div id={bodyId} hidden={!open} className="flex flex-col gap-4 border-t border-line px-4 py-4">
        {error && !errorInEditor && (
          <p role="alert" className="text-[0.8125rem] text-danger">
            {error}
          </p>
        )}
        {editor}
        <ConditionEditor condition={step.condition ?? null} fields={fields} hasRecord={hasRecord} onChange={(c) => onChange(withCondition(step, c))} />
      </div>
    </li>
  );
}

function ConditionEditor({ condition, fields, hasRecord, onChange }: { condition: Filter | null; fields: readonly Field[]; hasRecord: boolean; onChange: (c: Filter | null) => void }) {
  const { collaborators, schema } = useAutomationEnv();
  const [on, setOn] = useState(condition !== null);
  return (
    <div className="border-t border-line pt-3">
      <Checkbox
        checked={on && hasRecord}
        disabled={!hasRecord}
        onCheckedChange={(next) => {
          setOn(next);
          if (!next) onChange(null);
        }}
        label="Only run this action when the trigger record matches conditions"
      />
      {!hasRecord && <p className="mt-1 text-xs text-muted">Conditions need a record or form trigger: schedules and webhooks have no record to test.</p>}
      {on && hasRecord && (
        <div className="mt-3">
          <FilterBuilder
            value={condition}
            onChange={onChange}
            fields={fields}
            collaborators={collaborators}
            tables={schema.tables}
            label="Condition"
            emptyText="No conditions yet: the action always runs. Add a condition to limit it."
          />
        </div>
      )}
    </div>
  );
}
