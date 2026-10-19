/**
 * Link-to-another-record editor: search the linked table (`GET .../records/lookup?q=`) and pick one or
 * many. Where the project is known (the editing environment's schema), each result shows the first few
 * filled fields of its table's grid under its name, the search matches those fields too, and hovering a
 * result (or holding a finger on it) shows the whole record, so the right one can be told apart.
 */
import { useId, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { recordKeys, recordsApi } from "@/api/records";
import type { Field, LinkRef } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { linkRefs } from "@/lib/cells/kinds";
import { fieldsToShow } from "@/views/common/cardFields";
import { CellValue } from "../CellValue";
import { PREVIEW_FIELDS, RecordPeek, linkedTableOf, previewFields, useRecordsById } from "../linked/LinkedRecords";
import { EditorShell } from "./EditorShell";
import { useOptionalEditorEnv, type FieldEditorCallbacks } from "./env";
import { useDebounced } from "./useDebounced";

export interface LinkEditorProps extends FieldEditorCallbacks {
  field: Field;
  value: unknown;
  variant: "cell" | "form";
  target?: { width: number; height: number };
  initialText?: string;
}

export function LinkChip({ name, onRemove }: { name: string; onRemove?: () => void }) {
  return (
    <span className="choice choice-blue inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs font-medium">
      <span className="truncate">{name || "Untitled"}</span>
      {onRemove && (
        <button type="button" aria-label={`Remove ${name}`} onClick={onRemove} className="rounded hover:bg-black/10">
          <X aria-hidden className="size-3" />
        </button>
      )}
    </span>
  );
}

export function LinkEditor({ field, value, variant, target, initialText, onChange, onCommit: commitUp, onCancel }: LinkEditorProps) {
  const [selected, setSelected] = useState<LinkRef[]>(() => linkRefs(value));
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [query, setQuery] = useState(initialText ?? "");
  const [active, setActive] = useState(0);
  const listId = useId();
  const closeRef = useRef<() => void>(() => {});
  const commit: FieldEditorCallbacks["onCommit"] = (edit, move) => {
    commitUp(edit, move);
    closeRef.current();
  };
  const debounced = useDebounced(query, 180);
  const options = field.type === "link" ? field.options : null;
  const linkedTable = options?.linked_table_id ?? "";
  const single = options?.single ?? false;
  const env = useOptionalEditorEnv();
  const table = linkedTableOf(env?.schema, field);
  const role = env?.schema?.role ?? "viewer";
  const shownFields = useMemo(() => (table ? previewFields(table, role) : []), [table, role]);
  // The search matches what the results can show under their names.
  const searchFields = useMemo(() => shownFields.slice(0, PREVIEW_FIELDS * 2).map((f) => f.id), [shownFields]);

  const results = useQuery({
    queryKey: recordKeys.lookup(linkedTable, debounced, options?.picker_view_id ?? null, searchFields),
    queryFn: ({ signal }) => recordsApi.lookup(linkedTable, debounced, { viewId: options?.picker_view_id, fields: searchFields, signal }),
    enabled: !!linkedTable,
    placeholderData: keepPreviousData,
  });
  const candidates = (results.data?.records ?? []).filter((r) => !selected.some((s) => s.id === r.id));
  const total = candidates.length;
  const candidateIds = useMemo(() => (table ? candidates.map((c) => c.id) : []), [table, candidates]);
  const { records } = useRecordsById(table?.id, candidateIds);

  const set = (next: LinkRef[]) => {
    setSelected(next);
    onChange?.({ json: next });
  };
  const pick = (r: LinkRef) => {
    if (single) commit({ json: [r] });
    else set([...selectedRef.current, r]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(total - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = candidates[active];
      if (c) pick(c);
      else if (!single) commit({ json: selectedRef.current });
    } else if (e.key === "Backspace" && query === "" && !single && selectedRef.current.length > 0) {
      set(selectedRef.current.slice(0, -1));
    }
  };

  return (
    <EditorShell
      variant={variant}
      target={target}
      onCancel={onCancel}
      width={table ? 380 : 340}
      onDismiss={() => {
        if (variant === "form" && !single) commitUp({ json: selectedRef.current });
      }}
      triggerLabel={field.name}
      trigger={selected.length > 0 ? selected.map((r) => <LinkChip key={r.id} name={r.name} />) : <span className="text-faint">Link records…</span>}
    >
      {({ close }) => {
        closeRef.current = close;
        return (
          <>
            {selected.length > 0 && (
              <ul aria-label={`Linked records in ${field.name}`} className="flex max-h-24 flex-wrap gap-1 overflow-y-auto border-b border-line p-2">
                {selected.map((r) => {
                  const chip = <LinkChip name={r.name} onRemove={() => set(selected.filter((x) => x.id !== r.id))} />;
                  return (
                    <li key={r.id}>
                      {table && env ? (
                        <RecordPeek table={table} recordId={r.id} format={env.format} role={role} side="bottom">
                          {chip}
                        </RecordPeek>
                      ) : (
                        chip
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="relative border-b border-line p-2">
              <input
                data-autofocus
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={total > 0 ? `${listId}-${active}` : undefined}
                aria-label={`Search ${field.name}`}
                placeholder="Search records"
                className="h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-[0.8125rem] outline-none focus:border-ring"
              />
              {results.isFetching && <Spinner className="absolute right-4 top-4 size-3.5" label="Searching" />}
            </div>
            <ul id={listId} role="listbox" aria-multiselectable={!single} aria-label="Records" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
              {candidates.map((r, i) => {
                const rec = records.get(r.id);
                const shown = rec && env ? fieldsToShow(shownFields, rec, env.format, PREVIEW_FIELDS) : [];
                const row = (
                  <button type="button" tabIndex={-1} onMouseEnter={() => setActive(i)} onClick={() => pick(r)} className={cn("flex w-full min-w-0 flex-col gap-0.5 rounded px-2 py-1.5 text-left", i === active && "bg-hover")}>
                    <span className="truncate">{r.name || "Untitled"}</span>
                    {shown.length > 0 && rec && env && (
                      <span className="flex min-w-0 items-center gap-3 overflow-hidden text-xs text-muted">
                        {shown.map((f) => (
                          <span key={f.id} className="flex min-w-0 max-w-[50%] shrink items-center gap-1" title={f.name}>
                            <CellValue field={f} value={rec.values[f.id]} format={env.format} className="truncate text-xs" />
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                );
                return (
                  <li key={r.id} id={`${listId}-${i}`} role="option" aria-selected={false}>
                    {table && env ? (
                      <RecordPeek table={table} recordId={r.id} record={rec} format={env.format} role={role} side="right">
                        {row}
                      </RecordPeek>
                    ) : (
                      row
                    )}
                  </li>
                );
              })}
              {results.isError && <li className="px-2 py-3 text-center text-[0.8125rem] text-danger">Could not search records.</li>}
              {!results.isFetching && !results.isError && total === 0 && <li className="px-2 py-3 text-center text-[0.8125rem] text-muted">{debounced ? "No matching records." : "No more records to link."}</li>}
            </ul>
            <div className="flex items-center justify-between gap-2 border-t border-line p-2">
              <Button size="sm" variant="ghost" onClick={() => commit({ json: null })} disabled={selected.length === 0}>
                Clear
              </Button>
              {!single && (
                <Button size="sm" variant="primary" onClick={() => commit({ json: selectedRef.current })}>
                  Done
                </Button>
              )}
            </div>
          </>
        );
      }}
    </EditorShell>
  );
}
