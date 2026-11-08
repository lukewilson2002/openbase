/**
 * The filter bar of a view (COL-3): the core FilterBar wired to the view's draft. Chips are the view's filter,
 * one per condition; typing offers what the words could mean, best first (the plain-language parser, COL-4),
 * then the same words as a search of every property. Every change goes through `update`, which writes the
 * person's draft (COL-5): nothing here is saved to the view. View options (COL-6) sits in `trailing`, to the
 * right of the bar.
 *
 * `/` and Ctrl or Cmd+F focus the bar from anywhere on the page that is not already taking text.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMe } from "@/auth/useAuth";
import type { Collaborator, Condition, Table, ViewConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import { FilterBar, type FilterBarChip, type FilterBarSuggestion } from "@/components/ui/filter-bar";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Sheet } from "@/components/ui/sheet";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { isFilterable } from "@/lib/cells/filters";
import { browserTimeZone } from "@/lib/format";
import { conditionLabel, parsePhrase, type Candidate, type LabelPart } from "@/lib/phraseFilter";
import type { BaseSchema } from "@/api/types";
import { setFilter } from "./config";
import { addCondition, advancedLabel, chipsOf, isFlat, removeCondition, replaceCondition } from "./filterChips";
import { ConditionRow, FilterBuilder, useDraft } from "./FilterBuilder";
import { registerFilterInput } from "./filterInput";

export interface ViewFilterBarProps {
  schema: BaseSchema;
  table: Table;
  config: ViewConfig;
  update: (mutate: (c: ViewConfig) => ViewConfig) => void;
  collaborators: readonly Collaborator[];
  currentUserId: string | null;
  /** The view's search text (a view-only state, not part of the draft) and how to change it. */
  search: string;
  onSearchChange: (search: string) => void;
  timeZone?: string;
  /** What sits to the right of the bar: View options. */
  trailing?: ReactNode;
}

/** The words of a suggestion: the property and the value in bold, the operator plain. */
function PhraseLabel({ parts }: { parts: readonly LabelPart[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          {p.role === "property" || p.role === "value" ? <strong className="font-semibold">{p.text}</strong> : p.text}
        </Fragment>
      ))}
    </>
  );
}

/** A short stable tag for a label, so a suggestion keeps its identity (and the highlight resets) when the text changes under it. */
function tag(text: string): string {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) | 0;
  return (h >>> 0).toString(36);
}

const plain = (parts: readonly LabelPart[]) => parts.map((p) => p.text).join(" ");

/** True for a place where typing goes into text, so `/` is a character there and not the shortcut. */
function takesText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest("[contenteditable=''], [contenteditable=true]")) return true;
  if (target.closest("input, textarea, select, [role=textbox], [role=combobox], [role=searchbox]")) return true;
  // Inside a dialog, menu or sheet the page behind is not the thing being used.
  return !!target.closest("[role=dialog], [role=alertdialog], [role=menu]");
}

/** The editor of one filter chip: property, operator and value, in the editors the filter builder uses. */
function ChipEditor({ condition, table, schema, collaborators, onChange, onRemove, onDone }: { condition: Condition; table: Table; schema: BaseSchema; collaborators: readonly Collaborator[]; onChange: (c: Condition) => void; onRemove: () => void; onDone?: () => void }) {
  // A change still waiting out its pause when the filter is removed must not land on whichever condition took its place.
  const removed = useRef(false);
  const [cond, apply] = useDraft<Condition>(condition, (next) => {
    if (!removed.current) onChange(next);
  });
  const filterable = table.fields.filter(isFilterable);
  return (
    <div className="flex flex-col gap-3">
      <ConditionRow cond={cond} field={table.fields.find((f) => f.id === cond.field_id)} filterable={filterable} collaborators={collaborators} tables={schema.tables} onChange={(c, debounce) => apply(c, debounce)} />
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            removed.current = true;
            onRemove();
          }}
        >
          Remove filter
        </Button>
        {onDone && (
          <Button variant="soft" size="sm" onClick={onDone}>
            Done
          </Button>
        )}
      </div>
    </div>
  );
}

export function ViewFilterBar({ schema, table, config, update, collaborators, currentUserId, search, onSearchChange, timeZone, trailing }: ViewFilterBarProps) {
  const me = useMe();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const zone = timeZone ?? me.data?.timezone ?? browserTimeZone();
  const weekStart = me.data?.week_start === 1 ? 1 : 0;

  // The Page is a collection's body, not one of its properties: it takes no part in filters typed here.
  const fields = useMemo(() => table.fields.filter((f) => f.id !== table.body_field_id), [table.fields, table.body_field_id]);

  const candidates = useMemo(() => parsePhrase(text, { fields, userId: currentUserId, collaborators, now: new Date(), timeZone: zone, weekStart }), [text, fields, currentUserId, collaborators, zone, weekStart]);
  const suggestions = useMemo<FilterBarSuggestion[]>(() => candidates.map((c, i) => ({ id: `s${i}-${tag(plain(c.label))}`, label: <PhraseLabel parts={c.label} /> })), [candidates]);

  const say = (message: string) => setAnnouncement(message);
  const describe = (c: Condition) => conditionLabel(c, table.fields, { collaborators, timeZone: zone });

  const apply = (candidate: Candidate) => {
    if (candidate.kind === "search") {
      onSearchChange(candidate.query);
      say(`Searching every property for ${candidate.query}`);
    } else {
      update((c) => setFilter(c, addCondition(c.filter, candidate.condition) ?? c.filter ?? null));
      say(`Filter added: ${plain(candidate.label)}`);
    }
    setText("");
  };

  // A press elsewhere closes the builder too, and then focus belongs to what was pressed.
  const pressedOutside = useRef(false);
  const openAdvanced = () => {
    pressedOutside.current = false;
    setAdvancedOpen(true);
  };

  const model = chipsOf(config.filter);
  const filter = config.filter;
  const chips: FilterBarChip[] = model.map((m) => {
    if (m.kind === "advanced") return { id: "advanced", label: advancedLabel(m.count), onEdit: openAdvanced };
    return {
      id: `c${m.index}`,
      label: describe(m.condition),
      editor: (close) => (
        <ChipEditor
          // The condition at this place, whatever it is by the time the editor is read again.
          condition={m.condition}
          table={table}
          schema={schema}
          collaborators={collaborators}
          onChange={(next) => update((c) => (c.filter && isFlat(c.filter) ? setFilter(c, replaceCondition(c.filter, m.index, next)) : c))}
          onRemove={() => {
            update((c) => (c.filter && isFlat(c.filter) ? setFilter(c, removeCondition(c.filter, m.index)) : c));
            say(`Filter removed: ${describe(m.condition)}`);
            close();
          }}
          // The sheet on a phone has its own Done.
          onDone={desktop ? close : undefined}
        />
      ),
    };
  });
  if (search !== "") {
    chips.push({
      id: "search",
      label: `Search for “${search}”`,
      // The words go back into the field to be changed.
      onEdit: () => {
        setText(search);
        onSearchChange("");
        window.setTimeout(() => inputRef.current?.focus(), 0);
      },
    });
  }

  const removeChip = (id: string) => {
    if (id === "search") {
      onSearchChange("");
      say("Search cleared");
    } else if (id === "advanced") {
      update((c) => setFilter(c, null));
      say("Advanced filter removed");
    } else {
      const index = Number(id.slice(1));
      const gone = filter && isFlat(filter) ? filter.items[index] : undefined;
      update((c) => (c.filter && isFlat(c.filter) ? setFilter(c, removeCondition(c.filter, index)) : c));
      if (gone && "field_id" in gone) say(`Filter removed: ${describe(gone)}`);
    }
  };

  useEffect(() => {
    registerFilterInput(inputRef.current);
    return () => registerFilterInput(null);
  }, []);

  // `/` and Ctrl or Cmd+F. In the capture phase, so the grid's canvas does not take the key first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat) return;
      const find = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f";
      const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !takesText(e.target);
      if (!find && !slash) return;
      const input = inputRef.current;
      if (!input) return;
      // A modal dialog or sheet hides the page behind it from assistive technology: its focus stays inside, and the
      // browser's own Find stays available. A menu is the same for the key that was meant for it.
      if (find && (input.closest("[aria-hidden=true], [inert]") || (e.target instanceof HTMLElement && e.target.closest("[role=alertdialog], [role=menu]")))) return;
      e.preventDefault();
      e.stopPropagation();
      input.focus();
      input.select();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const closeAdvanced = () => {
    const restore = !pressedOutside.current;
    pressedOutside.current = false;
    setAdvancedOpen(false);
    if (desktop && restore) window.setTimeout(() => inputRef.current?.focus(), 0);
  };
  const builder = (
    <FilterBuilder
      label="Advanced filter"
      value={config.filter ?? null}
      onChange={(f) => update((c) => setFilter(c, f))}
      fields={table.fields.filter(isFilterable)}
      collaborators={collaborators}
      tables={schema.tables}
      readOnly={false}
      emptyText="Add a condition to filter the records."
    />
  );

  return (
    <Popover open={advancedOpen && desktop} onOpenChange={(next) => !next && closeAdvanced()} modal={false}>
      <PopoverAnchor asChild>
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2 md:px-10">
          <FilterBar
            chips={chips}
            onRemoveChip={removeChip}
            text={text}
            onTextChange={setText}
            suggestions={suggestions}
            onApplySuggestion={(s) => {
              const candidate = candidates[suggestions.indexOf(s)];
              if (candidate) apply(candidate);
            }}
            footerAction={{ label: "Advanced filter", onSelect: openAdvanced }}
            inputRef={inputRef}
          />
          {trailing}
          <span role="status" aria-live="polite" className="sr-only">
            {announcement}
          </span>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        onInteractOutside={() => (pressedOutside.current = true)}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="max-h-[min(34rem,var(--ob-avail))] w-[min(46rem,calc(100vw-1.5rem))] overflow-y-auto p-3"
      >
        {builder}
      </PopoverContent>
      {!desktop && (
        <Sheet open={advancedOpen} onOpenChange={setAdvancedOpen} title="Advanced filter">
          {builder}
        </Sheet>
      )}
    </Popover>
  );
}
