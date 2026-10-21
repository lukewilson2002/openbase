/**
 * Link-to-another-record editor: search the linked table (`GET .../records/lookup?q=`) and pick one or
 * many. Where the project is known (the editing environment's schema), the records picked so far are
 * cards (`LinkedRecordList`: reordered by their grips, removed with ✕). In a form (the record panel, a
 * form view) they stay in the field just as when it is not edited; in the grid the cell opens out
 * into a box of them over the grid. Either way the pop-over under them only searches and picks (Done
 * in a form; in the grid a click elsewhere keeps the edit). Each result is a detailed
 * summary (a longer description and a few more fields) of its table's grid; the search matches those
 * fields too, and hovering a record (or holding a finger on it) shows the whole of it.
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
import { LinkedRecordList } from "../linked/LinkedRecordList";
import { PREVIEW_FIELDS, RecordPeek, linkedTableOf, previewFields, titleOf, useRecordsById } from "../linked/LinkedRecords";
import { RecordSummary } from "../RecordSummary";
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
    // A linked record as a small card, as in the grid's cells: a hairline border, its title in the app's colour.
    <span className="inline-flex max-w-full items-center gap-1 truncate rounded border border-line bg-surface px-1.5 py-px text-xs font-medium text-primary-text">
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
  const searchRef = useRef<HTMLInputElement>(null);
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
  const selectedIds = useMemo(() => (table ? selected.map((r) => r.id) : []), [table, selected]);
  const { records: selectedRecords } = useRecordsById(table?.id, selectedIds);

  const set = (next: LinkRef[]) => {
    setSelected(next);
    onChange?.({ json: next });
  };
  // Where the project is known, picked records are cards that can be reordered and removed; in a form
  // (the record panel, a form view) they stay in the field itself, the pop-over only finding more.
  const cards =
    table && env
      ? (refs: LinkRef[]) => (
          <LinkedRecordList
            fieldName={field.name}
            table={table}
            refs={refs.map((r) => ({ ...r, name: titleOf(table, selectedRecords.get(r.id), r.name, env.format) }))}
            records={selectedRecords}
            fields={shownFields}
            format={env.format}
            role={role}
            onChange={(next) => {
              // A removed card takes its focused ✕ with it: the search keeps the focus in the editor.
              searchRef.current?.focus({ preventScroll: true });
              set(next.map((n) => refs.find((r) => r.id === n.id) ?? n));
            }}
          />
        )
      : null;
  // The cards stay outside the pop-over: in the field itself in a form, over the cell in the grid.
  const inPlace = !!cards;
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
      anchor={
        inPlace && variant === "cell"
          ? () => (
              // The cell opens out into its records, as many as there are (scrolling past a few).
              <div
                style={{ width: Math.max(target?.width ?? 0, table ? 380 : 340) }}
                className="max-h-72 overflow-y-auto overscroll-contain rounded-md border border-ring bg-surface p-1.5 shadow-pop"
              >
                {selected.length > 0 ? cards!(selected) : <p className="px-1.5 py-1 text-[0.8125rem] text-faint">No linked records yet.</p>}
              </div>
            )
          : inPlace
          ? ({ open }) => (
              // The field's cards as they are when it is not edited (see EditableValue), with the search under them.
              <div
                role="button"
                tabIndex={0}
                aria-label={field.name}
                aria-haspopup="dialog"
                onClick={(e) => {
                  if (!(e.target as Element).closest("button, a")) open();
                }}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    open();
                  }
                }}
                className="outline-none focus-visible:ring-2 focus-visible:ring-ring flex min-h-8 w-full min-w-0 cursor-pointer flex-col justify-center rounded-md border border-ring px-2 py-1 pb-3 text-[0.8125rem] pointer-coarse:min-h-11"
              >
                {selected.length > 0 ? cards!(selected) : <span className="text-faint">Empty</span>}
              </div>
            )
          : undefined
      }
    >
      {({ close }) => {
        closeRef.current = close;
        return (
          <>
            {!inPlace && selected.length > 0 && (
              // Without the project at hand there are no cards: the picked records are chips here, above the
              // search, with their own height (never squeezed by the results), scrolling past a few.
              <ul aria-label={`Linked records in ${field.name}`} className="flex max-h-36 shrink-0 flex-wrap gap-1 overflow-y-auto overscroll-contain border-b border-line p-1.5">
                {selected.map((r) => (
                  <li key={r.id}>
                    <LinkChip name={r.name} onRemove={() => set(selected.filter((x) => x.id !== r.id))} />
                  </li>
                ))}
              </ul>
            )}
            <div className="relative border-b border-line p-2">
              <input
                ref={searchRef}
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
                const name = <span className="max-w-full truncate">{r.name || "Untitled"}</span>;
                const row = (
                  <button type="button" tabIndex={-1} onMouseEnter={() => setActive(i)} onClick={() => pick(r)} className={cn("flex w-full min-w-0 rounded px-2 py-1.5 text-left", i === active && "bg-hover")}>
                    {/* While choosing, a little more of each record than elsewhere, to be sure it is the right one. */}
                    {env ? <RecordSummary title={name} record={rec} fields={shownFields} format={env.format} detailed /> : name}
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
            {/* In place, the cards above remove their records: the panel only finds new ones. */}
            {(!inPlace || !single) && (
              <div className="flex items-center justify-between gap-2 border-t border-line p-2">
                {!inPlace && (
                  <Button size="sm" variant="ghost" onClick={() => commit({ json: null })} disabled={selected.length === 0}>
                    Clear
                  </Button>
                )}
                {!single && (
                  <Button size="sm" variant="primary" className="ml-auto" onClick={() => commit({ json: selectedRef.current })}>
                    Done
                  </Button>
                )}
              </div>
            )}
          </>
        );
      }}
    </EditorShell>
  );
}
