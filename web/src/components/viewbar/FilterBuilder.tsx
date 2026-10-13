/**
 * Nested filter builder (up to 3 levels, and/or per group). Operators per field type come from
 * `filterOpsFor` (mirror of ob_core::query::filter_ops_for). Edits are applied locally at once
 * and reported through `onChange` after a short pause while typing (structural changes are
 * reported immediately), so the view is not re-saved on every keystroke.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Collaborator, Condition, Conjunction, Field, Filter, FilterItem, FilterOp, Table } from "@/api/types";
import { Button } from "@/components/ui/button";
import { InlineSelect } from "./InlineSelect";
import { IconButton } from "@/components/ui/icon-button";
import { MAX_FILTER_CONDITIONS, MAX_FILTER_DEPTH, countConditions, filterOpsFor, isFilterable, isGroup, newCondition, opLabel, operandKindFor, withOp } from "@/lib/cells/filters";
import { kindClassOf } from "@/lib/cells/kinds";
import { OperandEditor } from "./OperandEditor";

export interface FilterBuilderProps {
  value: Filter | null;
  onChange: (value: Filter | null) => void;
  /** Fields that can be filtered on. */
  fields: readonly Field[];
  collaborators: readonly Collaborator[];
  tables?: readonly Table[];
  readOnly?: boolean;
  /** Text for the empty state. */
  emptyText?: string;
  /** Used to name the controls ("Filter 1", ...) for assistive tech. */
  label?: string;
}

const DEBOUNCE_MS = 450;

/** Local draft of a filter that reports to the parent immediately or after a pause. */
function useDraft(value: Filter | null, onChange: (v: Filter | null) => void) {
  const [draft, setDraft] = useState<Filter | null>(value);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(draft);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!dirty.current) {
      setDraft(value);
      latest.current = value;
    }
  }, [value]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (dirty.current) {
      dirty.current = false;
      onChangeRef.current(latest.current);
    }
  }, []);

  // Closing the menu must not lose a pending edit.
  useEffect(() => flush, [flush]);

  const apply = useCallback(
    (next: Filter | null, debounce: boolean) => {
      latest.current = next;
      dirty.current = true;
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      if (debounce) timer.current = setTimeout(flush, DEBOUNCE_MS);
      else flush();
    },
    [flush],
  );
  return [draft, apply] as const;
}

export function FilterBuilder({ value, onChange, fields, collaborators, tables, readOnly, emptyText = "No filters applied to this view.", label = "Filter" }: FilterBuilderProps) {
  const [draft, apply] = useDraft(value, onChange);
  const filterable = fields.filter(isFilterable);
  const fieldsById = new Map(fields.map((f) => [f.id, f] as const));
  const root: Filter = draft ?? { conjunction: "and", items: [] };
  const total = countConditions(root);

  /** Replace the group at `path` (indexes into nested `items`) using `fn`; the root has an empty path. */
  const edit = (path: readonly number[], fn: (g: Filter) => Filter, debounce = false) => {
    const rec = (g: Filter, rest: readonly number[]): Filter => {
      if (rest.length === 0) return fn(g);
      const [i, ...tail] = rest as [number, ...number[]];
      return { ...g, items: g.items.map((it, k) => (k === i && isGroup(it) ? rec(it, tail) : it)) };
    };
    const next = rec(root, path);
    apply(next.items.length === 0 ? null : next, debounce);
  };

  const render = (group: Filter, path: readonly number[], depth: number) => (
    <div className={depth > 1 ? "rounded-md border border-line bg-subtle/60 p-2" : undefined} role="group" aria-label={depth > 1 ? `${label} group` : label}>
      <ul className="flex flex-col gap-2">
        {group.items.map((item, i) => (
          <li key={i} className="flex flex-wrap items-start gap-1.5">
            <span className="w-[4.5rem] shrink-0 pt-1.5 text-[0.8125rem] text-muted">
              {i === 0 ? (
                "Where"
              ) : i === 1 ? (
                <InlineSelect
                  aria-label="Match all or any"
                  width="w-full"
                  disabled={readOnly}
                  value={group.conjunction}
                  onChange={(e) => edit(path, (g) => ({ ...g, conjunction: e.target.value as Conjunction }))}
                >
                  <option value="and">and</option>
                  <option value="or">or</option>
                </InlineSelect>
              ) : (
                group.conjunction
              )}
            </span>
            {isGroup(item) ? (
              <div className="min-w-0 flex-1">{render(item, [...path, i], depth + 1)}</div>
            ) : (
              <ConditionRow
                cond={item}
                field={fieldsById.get(item.field_id)}
                filterable={filterable}
                collaborators={collaborators}
                tables={tables}
                readOnly={readOnly}
                onChange={(c, debounce) => edit(path, (g) => ({ ...g, items: g.items.map((it, k) => (k === i ? c : it)) }), debounce)}
              />
            )}
            <IconButton label="Remove condition" size="sm" noTooltip disabled={readOnly} onClick={() => edit(path, (g) => ({ ...g, items: g.items.filter((_, k) => k !== i) }))}>
              <Trash2 aria-hidden className="size-4" />
            </IconButton>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={filterable.length === 0 || total >= MAX_FILTER_CONDITIONS}
            onClick={() => edit(path, (g) => ({ ...g, items: [...g.items, newCondition(filterable[0]!)] as FilterItem[] }))}
          >
            <Plus aria-hidden className="size-4" /> Add condition
          </Button>
          {depth < MAX_FILTER_DEPTH && (
            <Button
              size="sm"
              variant="ghost"
              disabled={filterable.length === 0 || total >= MAX_FILTER_CONDITIONS}
              onClick={() => edit(path, (g) => ({ ...g, items: [...g.items, { conjunction: "and", items: [newCondition(filterable[0]!)] }] }))}
            >
              <Plus aria-hidden className="size-4" /> Add condition group
            </Button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div>
      {root.items.length === 0 ? <p className="mb-2 text-[0.8125rem] text-muted">{emptyText}</p> : null}
      {render(root, [], 1)}
    </div>
  );
}

function ConditionRow({
  cond,
  field,
  filterable,
  collaborators,
  tables,
  readOnly,
  onChange,
}: {
  cond: Condition;
  field: Field | undefined;
  filterable: readonly Field[];
  collaborators: readonly Collaborator[];
  tables?: readonly Table[];
  readOnly?: boolean;
  onChange: (c: Condition, debounce: boolean) => void;
}) {
  const ops: FilterOp[] = field ? filterOpsFor(field) : [];
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-1.5">
      <InlineSelect
        aria-label="Field"
        width="w-40"
        disabled={readOnly}
        value={field ? field.id : ""}
        onChange={(e) => {
          const next = filterable.find((f) => f.id === e.target.value);
          if (!next) return;
          // Keep the operator and operand only when they mean the same thing for the new field.
          const keep = !!field && filterOpsFor(next).includes(cond.op) && operandKindFor(next, cond.op) === operandKindFor(field, cond.op) && kindClassOf(next) === kindClassOf(field);
          onChange(keep ? { ...cond, field_id: next.id } : newCondition(next), false);
        }}
      >
        {!field && <option value="">(deleted field)</option>}
        {filterable.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </InlineSelect>
      <InlineSelect aria-label="Operator" width="w-40" disabled={readOnly || !field} value={cond.op} onChange={(e) => field && onChange(withOp(cond, field, e.target.value as FilterOp), false)}>
        {ops.map((o) => (
          <option key={o} value={o}>
            {opLabel(o, field)}
          </option>
        ))}
      </InlineSelect>
      {field && <OperandEditor field={field} op={cond.op} value={cond.value} collaborators={collaborators} tables={tables} readOnly={readOnly} onChange={(v, o) => onChange({ ...cond, value: v as Condition["value"] }, !!o?.typing)} />}
    </div>
  );
}
