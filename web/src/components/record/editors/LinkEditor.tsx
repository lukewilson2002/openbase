/**
 * Link-to-another-record editor, the link picker (FLD-5): search the linked collection
 * (`GET .../records/lookup?q=`) and pick one or many. Where the folder is known (the editing environment's
 * schema), the records picked so far are cards (`LinkedRecordList`: reordered by their grips, removed with
 * the x). In a form (the record page, a form view) they stay in the property just as when it is not edited; in
 * the grid the cell opens out into a box of them over the grid. Either way the pop-over under them only
 * searches and picks (Done in a form; in the grid a click elsewhere keeps the edit). On a phone the pop-over is
 * a bottom sheet (PH-3). Each result is a detailed summary (a longer description and a few more properties)
 * of its collection's grid; the search matches those properties too, and hovering a record shows the whole
 * of it (`RecordPeek`).
 */
import { Fragment, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { recordKeys, recordsApi } from "@/api/records";
import type { Field, LinkRef } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LinkChip } from "@/components/ui/link-chip";
import { ListboxOption } from "@/components/ui/listbox";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { linkRefs } from "@/lib/cells/kinds";
import { LinkedRecordList } from "../linked/LinkedRecordList";
import { PREVIEW_FIELDS, RecordPeek, linkedTableOf, previewFields, titleOf, useRecordsById } from "../linked/LinkedRecords";
import { RecordSummary } from "../RecordSummary";
import { EditorShell } from "./EditorShell";
import { useOptionalEditorEnv, type FieldEditorCallbacks, type Move } from "./env";
import { useDebounced } from "./useDebounced";

export interface LinkEditorProps extends FieldEditorCallbacks {
  field: Field;
  value: unknown;
  variant: "cell" | "form";
  target?: { width: number; height: number };
  initialText?: string;
  /**
   * Makes this the picker that only adds (the "+ Link" row of a page's Linked records): the host's own button
   * opens the search, and each record picked is added to the links at once, the picker closing. The records
   * linked already are the host's to show.
   */
  addAnchor?: (api: { open: () => void }) => ReactNode;
}

// The chip itself is a core component (DL-3); this re-export keeps the editors' imports as they were.
export { LinkChip };

export function LinkEditor({ field, value, variant, target, initialText, addAnchor, onChange, onCommit: commitUp, onCancel }: LinkEditorProps) {
  const [selected, setSelected] = useState<LinkRef[]>(() => linkRefs(value));
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [query, setQuery] = useState(initialText ?? "");
  const [active, setActive] = useState(0);
  // The highlight is the user's choice once they typed or moved it; before that it only rests on the first row.
  const [moved, setMoved] = useState(false);
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
  const shownFields = useMemo(() => (table ? previewFields(table) : []), [table]);
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
            onChange={(next) => {
              // A removed card takes its focused ✕ with it: the search keeps the focus in the editor.
              searchRef.current?.focus({ preventScroll: true });
              set(next.map((n) => refs.find((r) => r.id === n.id) ?? n));
            }}
          />
        )
      : null;
  // The cards stay outside the pop-over: in the field itself in a form, over the cell in the grid.
  const adding = !!addAnchor;
  const inPlace = !!cards || adding;
  const pick = (r: LinkRef, move?: Move) => {
    if (adding) {
      const next = single ? [r] : [...selectedRef.current, r];
      setSelected(next);
      commit({ json: next }, move);
    } else if (single) {
      // The editor can stay mounted after this (a form), so it shows the pick at once.
      setSelected([r]);
      commit({ json: [r] }, move);
    } else set([...selectedRef.current, r]);
  };

  /** Clears the value; the chips go at once, the editor can stay mounted after this (a form). */
  const clear = () => {
    setSelected([]);
    commit({ json: null });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMoved(true);
      setActive((a) => Math.min(total - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMoved(true);
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      // Enter on one record picks it and goes on to the next row; on several it adds, and Ctrl or Cmd with it (or
      // Enter with nothing to add) is done.
      const down: Move | undefined = variant === "cell" ? [0, e.shiftKey ? -1 : 1] : undefined;
      const c = candidates[active];
      if (!single && (e.ctrlKey || e.metaKey)) commit({ json: selectedRef.current }, down);
      else if (c) pick(c, down);
      else if (!single) commit({ json: selectedRef.current }, down);
    } else if (e.key === "Tab" && variant === "cell") {
      e.preventDefault();
      e.stopPropagation();
      // Tab takes the highlighted record when the user went looking for one, else what is linked already.
      const lit = moved || query.trim() !== "" ? candidates[active] : undefined;
      const json = single
        ? lit
          ? [lit]
          : selectedRef.current.length > 0
            ? selectedRef.current
            : null
        : lit && query.trim() !== ""
          ? [...selectedRef.current, lit]
          : selectedRef.current;
      commit({ json }, [e.shiftKey ? -1 : 1, 0]);
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
      sheetOnPhone
      onDismiss={() => {
        if (variant === "form" && !single && !adding) commitUp({ json: selectedRef.current });
      }}
      triggerLabel={field.name}
      trigger={selected.length > 0 ? selected.map((r) => <LinkChip key={r.id} name={r.name} hue={table?.color} markName={table?.name} />) : <span className="text-faint">Link records…</span>}
      anchor={
        addAnchor ??
        (inPlace && variant === "cell"
          ? () => (
              // The cell opens out into its records, as many as there are (scrolling past a few).
              <div
                style={{ width: Math.max(target?.width ?? 0, table ? 380 : 340) }}
                className="max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-ring bg-surface p-1.5 shadow-pop"
              >
                {selected.length > 0 ? cards!(selected) : <p className="px-1.5 py-1 text-label text-faint">No linked records yet.</p>}
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
                className="flex min-h-8 w-full min-w-0 cursor-pointer flex-col justify-center rounded-md border border-ring px-2 py-1 pb-3 text-label outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-control-touch pointer-coarse:min-h-control-touch"
              >
                {selected.length > 0 ? cards!(selected) : <span className="text-faint">Empty</span>}
              </div>
            )
          : undefined)
      }
    >
      {({ close, sheet }) => {
        closeRef.current = close;
        return (
          <>
            {!inPlace && selected.length > 0 && (
              // Without the folder at hand there are no cards: the picked records are chips here, above the
              // search, with their own height (never squeezed by the results), scrolling past a few.
              <ul aria-label={`Linked records in ${field.name}`} className={cn("flex max-h-36 shrink-0 flex-wrap gap-1 overflow-y-auto overscroll-contain p-2", sheet ? "px-0" : "border-b border-line")}>
                {selected.map((r) => (
                  <li key={r.id}>
                    <LinkChip name={r.name} onRemove={() => set(selected.filter((x) => x.id !== r.id))} />
                  </li>
                ))}
              </ul>
            )}
            {/* On a sheet the search stays at the top while the list scrolls under it. */}
            <div className={cn("relative shrink-0 p-2", sheet ? "sticky top-0 z-10 -mx-4 bg-surface px-4" : "border-b border-line")}>
              <Input
                ref={searchRef}
                data-autofocus
                // A sheet on a touch screen opens with the keyboard down: the list is there to be read first.
                autoFocus={!sheet}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                  setMoved(false);
                }}
                onKeyDown={onKey}
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={total > 0 ? `${listId}-${active}` : undefined}
                aria-label={`Search ${field.name}`}
                placeholder="Search records"
                className="pr-8 max-md:h-control-touch"
              />
              {results.isFetching && <Spinner className={cn("absolute top-1/2 size-3.5 -translate-y-1/2", sheet ? "right-6" : "right-4")} label="Searching" />}
            </div>
            <div id={listId} role="listbox" aria-multiselectable={!single} aria-label="Records" className={cn("min-h-0 flex-1 p-1.5", sheet ? "px-0" : "overflow-y-auto overscroll-contain")}>
              {candidates.map((r, i) => {
                const rec = records.get(r.id);
                const name = <span className="max-w-full truncate text-ui font-medium">{r.name || "Untitled"}</span>;
                // While choosing, a little more of each record than elsewhere, to be sure it is the right one.
                const row = (
                  <ListboxOption id={`${listId}-${i}`} active={i === active} rich onHover={() => setActive(i)} onSelect={() => pick(r)}>
                    {env ? <RecordSummary title={name} record={rec} fields={shownFields} format={env.format} detailed /> : name}
                  </ListboxOption>
                );
                // The preview opens on hover. A finger meets a record's details in the row itself, and a sheet
                // does not open another over itself.
                return table && env ? (
                  <RecordPeek key={r.id} table={table} recordId={r.id} record={rec} format={env.format} side="right" touchHold={false}>
                    {row}
                  </RecordPeek>
                ) : (
                  <Fragment key={r.id}>{row}</Fragment>
                );
              })}
              {results.isError && <p role="status" className="px-2 py-3 text-center text-label text-danger">Could not search records.</p>}
              {!results.isFetching && !results.isError && total === 0 && <p role="status" className="px-2 py-3 text-center text-label text-muted">{debounced ? "No matching records." : "No more records to link."}</p>}
            </div>
            {/* In place, the cards above remove their records: the panel only finds new ones. A sheet has its own Done. */}
            {!adding && (!inPlace || (!single && !sheet)) && (
              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line p-2">
                {!inPlace && (
                  <Button size="sm" variant="ghost" onClick={clear} disabled={selected.length === 0}>
                    Clear
                  </Button>
                )}
                {!single && !sheet && (
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
