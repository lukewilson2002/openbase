/**
 * The view toolbar, one row: the table and view picker, then Filter, Sort, Group, Hide fields, Color
 * and Row height (each tinted and naming what it does once in use, "Sorted by Who"), the view type's
 * own settings, and More; search and the base-coloured Add at the end. Tools that do not fit move
 * into More from the right end first; Add field and Download CSV always live there. On a phone the
 * tools fold into one menu behind a sliders button and Add floats at the bottom corner.
 *
 * Every change is a pure mutation of the view config (see ./config.ts) applied through `update`,
 * which persists the full config with PATCH /api/views/{id}. People who cannot save the view
 * (viewers and commenters, editors on locked views) can still filter, sort and group for
 * themselves: `update` then keeps those as a local override that is sent with each query and
 * marked "Not saved" here. Colours stay read-only for them.
 *
 * Sharing a view lives in the base's Share dialog ("Share a view") and in each view's menu.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Check, ChevronDown, Download, EyeOff, Filter as FilterIcon, Group, ListFilter, Lock, PaintBucket, Plus, Rows3, Search, SlidersHorizontal, X } from "lucide-react";
import type { BaseSchema, Collaborator, Filter, RowColor, RowHeight, Table, View, ViewConfig } from "@/api/types";
import { useExportCsv } from "@/components/csv/ExportCsvButton";
import { Button } from "@/components/ui/button";
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import { Switch } from "@/components/ui/checkbox";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Select } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { countConditions, isFilterable } from "@/lib/cells/filters";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { visibleToolCount } from "./toolbarFit";
import { FilterBuilder } from "./FilterBuilder";
import { SortListEditor } from "./SortListEditor";
import { ViewSwitcher } from "./ViewSwitcher";
import {
  MAX_GROUPS,
  MAX_SORTS,
  ROW_HEIGHT_LABELS,
  addSortLike,
  isGroupable,
  isSortable,
  moveSortLike,
  removeSortLike,
  resolveFieldOrder,
  setAllHidden,
  setFilter,
  setHiddenField,
  setRowColor,
  setRowHeight,
  updateSortLike,
} from "./config";

/** Add looks like a secondary button: the toolbar has no colored call to action. */
const addButtonClass = "border border-line-strong bg-surface text-fg hover:bg-hover";

export interface ViewBarProps {
  schema: BaseSchema;
  table: Table;
  view: View;
  role: string;
  config: ViewConfig;
  /** Whether changes can be saved to the view. When false, filter/sort/group apply to this viewer only. */
  canConfigure: boolean;
  /** A local (unsaved) filter, sort or group is in effect. */
  hasLocalQuery: boolean;
  onResetLocalQuery: () => void;
  saving: boolean;
  update: (mutate: (c: ViewConfig) => ViewConfig) => void;
  collaborators: readonly Collaborator[];
  currentUserId: string | null;
  search: string;
  onSearchChange: (s: string) => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  /**
   * Adds a field (the grid, for creators). The grid's header has its own "+" too, but that is drawn
   * on a canvas: this menu item is the way to it by keyboard and screen reader.
   */
  onAddField?: () => void;
  /** Toolbar sections a view type does not use can be switched off (all on by default). */
  features?: { group?: boolean; color?: boolean; rowHeight?: boolean; csv?: boolean };
  /** Viewer's IANA zone, used by the CSV export for dates. */
  timeZone?: string;
  /** Label of the hide-fields menu ("Hide fields" in the grid, "Card fields" on card views). */
  hideFieldsNoun?: string;
  /**
   * The view type's main setting ("Stacked by How often", "Dates from Last done"), shown first: it
   * decides what the view is, so it reads before the tools that narrow it down.
   */
  setting?: ReactNode;
  /** View-type specific controls shown after the tools. */
  extra?: ReactNode;
  /** View-type switches for the More menu ("Hide empty stacks"), listed after the colour settings. */
  moreToggles?: readonly MoreToggle[];
  /** Adds a record (the toolbar's "Add"); omitted where the view adds records its own way or the viewer cannot. */
  onAdd?: () => void;
}

/** An on/off item of the More menu. */
export interface MoreToggle {
  id: string;
  label: string;
  icon: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onToggle: (on: boolean) => void;
}

const toolClass =
  "inline-flex h-9 items-center gap-1.5 rounded-[9px] px-2.5 text-[0.875rem] text-fg transition-colors hover:bg-hover data-[state=open]:bg-hover pointer-coarse:h-11";
const toolActiveClass = "bg-primary-soft text-primary-ink hover:bg-primary-soft data-[state=open]:bg-primary-soft";

/** Classes of a toolbar tool, tinted while it is in use; views use it for their own settings. */
export function toolButtonClass(active?: boolean): string {
  return cn(toolClass, active && toolActiveClass);
}

/** A desktop tool: a plain word that opens its editor below it, tinted while the tool is in use. */
function ToolButton({ label, active, children, note, wide }: { label: string; active?: boolean; children: ReactNode; note?: string; wide?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(toolClass, active && toolActiveClass)}>
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn("max-h-[min(34rem,var(--ob-avail))] overflow-y-auto p-3", wide ? "w-[min(46rem,calc(100vw-1.5rem))]" : "w-[min(30rem,calc(100vw-1.5rem))]")}>
        {note && <p className="mb-2 rounded bg-warning-soft px-2 py-1 text-xs">{note}</p>}
        {children}
      </PopoverContent>
    </Popover>
  );
}

type ToolEntry =
  | { kind: "panel"; id: string; label: string; icon: ReactNode; value?: string; active?: boolean; note?: string; wide?: boolean; panel: ReactNode }
  | { kind: "action"; id: string; label: string; icon: ReactNode; busy?: boolean; onSelect: () => void }
  | { kind: "toggle"; id: string; label: string; icon: ReactNode; checked: boolean; disabled?: boolean; onSelect: () => void }
  | { kind: "separator"; id: string };

/**
 * A menu of tools in a popover (desktop More, the phone's tools): picking a tool shows its editor
 * in the same popover with a way back; an action runs and closes the menu.
 */
function ToolMenu({ trigger, label, entries, footer, align = "start" }: { trigger: ReactNode; label: string; entries: ToolEntry[]; footer?: ReactNode; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const [panelId, setPanelId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panel = entries.find((e): e is Extract<ToolEntry, { kind: "panel" }> => e.kind === "panel" && e.id === panelId);

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled]),[role=menuitemcheckbox]:not([disabled])") ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPanelId(null);
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        onOpenAutoFocus={(e) => {
          // The first tool, not the popover itself, so the arrow keys work straight away.
          e.preventDefault();
          listRef.current?.querySelector<HTMLElement>("[role=menuitem],[role=menuitemcheckbox]")?.focus();
        }}
        className={cn("max-h-[min(34rem,var(--ob-avail))] overflow-y-auto rounded-xl p-1.5", panel ? (panel.wide ? "w-[min(46rem,calc(100vw-1.5rem))]" : "w-[min(30rem,calc(100vw-1.5rem))]") : "w-[min(15.5rem,calc(100vw-1.5rem))]")}
      >
        {panel ? (
          <div className="flex flex-col gap-2 p-1.5">
            <div className="-ml-1 flex items-center gap-1">
              <IconButton label="Back to the tools" size="sm" noTooltip autoFocus onClick={() => setPanelId(null)}>
                <ArrowLeft aria-hidden className="size-4" />
              </IconButton>
              <h3 className="text-[0.875rem] font-semibold">{panel.label}</h3>
            </div>
            {panel.note && <p className="rounded bg-warning-soft px-2 py-1 text-xs">{panel.note}</p>}
            {panel.panel}
          </div>
        ) : (
          <div ref={listRef} role="menu" aria-label={label} onKeyDown={onListKey} className="flex flex-col gap-px">
            {entries.map((e) =>
              e.kind === "separator" ? (
                <div key={e.id} role="separator" className="mx-1 my-1 h-px bg-line" />
              ) : (
                <button
                  key={e.id}
                  type="button"
                  role={e.kind === "toggle" ? "menuitemcheckbox" : "menuitem"}
                  aria-checked={e.kind === "toggle" ? e.checked : undefined}
                  disabled={(e.kind === "action" && e.busy) || (e.kind === "toggle" && e.disabled)}
                  onClick={() => {
                    if (e.kind === "panel") setPanelId(e.id);
                    else {
                      e.onSelect();
                      setOpen(false);
                    }
                  }}
                  className={cn(
                    "flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[0.875rem] text-fg outline-none hover:bg-hover focus-visible:bg-hover disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:text-[0.9375rem]",
                    e.kind === "panel" && e.active && "bg-primary-soft font-semibold text-primary-ink hover:bg-primary-soft",
                  )}
                >
                  <span className="flex shrink-0 items-center [&>svg]:size-4">{e.kind === "action" && e.busy ? <Spinner className="size-4" label="Working" /> : e.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{e.label}</span>
                  {e.kind === "panel" && e.value && <span className="max-w-[45%] truncate text-[0.8125rem] font-semibold text-primary">{e.value}</span>}
                  {e.kind === "toggle" && e.checked && <Check aria-hidden className="size-4 shrink-0 text-primary" />}
                </button>
              ),
            )}
            {footer}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function HideFields({ table, config, update }: { table: Table; config: ViewConfig; update: ViewBarProps["update"] }) {
  const [q, setQ] = useState("");
  const { all } = resolveFieldOrder(table, config);
  const hidden = new Set(config.hidden_fields);
  const shown = all.filter((f) => f.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div>
      <Input aria-label="Find a field" placeholder="Find a field" value={q} onChange={(e) => setQ(e.target.value)} className="mb-2" />
      <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {shown.map((f) => {
          const primary = f.id === table.primary_field_id;
          return (
            <li key={f.id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-hover">
              <FieldTypeIcon type={f.type} />
              <Switch className="min-w-0 flex-1 flex-row-reverse justify-between" label={<span className="truncate">{f.name}</span>} checked={primary || !hidden.has(f.id)} disabled={primary} onCheckedChange={(on) => update((c) => setHiddenField(c, table, f.id, !on))} />
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-1 py-2 text-[0.8125rem] text-muted">No matching fields.</li>}
      </ul>
      <div className="mt-2 flex gap-2 border-t border-line pt-2">
        <Button size="sm" variant="secondary" onClick={() => update((c) => setAllHidden(c, table, true))}>
          Hide all
        </Button>
        <Button size="sm" variant="secondary" onClick={() => update((c) => setAllHidden(c, table, false))}>
          Show all
        </Button>
      </div>
    </div>
  );
}

function ColorMenu({ table, config, update, props, readOnly }: { table: Table; config: ViewConfig; update: ViewBarProps["update"]; props: Pick<ViewBarProps, "collaborators" | "schema">; readOnly: boolean }) {
  const rc = config.row_color ?? null;
  const mode = rc?.mode ?? "none";
  const selects = table.fields.filter((f) => f.type === "single_select");
  const setMode = (m: string) => {
    if (m === "none") update((c) => setRowColor(c, null));
    else if (m === "by_select") update((c) => setRowColor(c, { mode: "by_select", field_id: selects[0]?.id ?? "" }));
    else update((c) => setRowColor(c, { mode: "by_conditions", rules: [{ color: "blue", filter: { conjunction: "and", items: [] } }] }));
  };
  const rules = rc?.mode === "by_conditions" ? rc.rules : [];
  const setRules = (next: typeof rules) => update((c) => setRowColor(c, { mode: "by_conditions", rules: next } as RowColor));
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1.5" disabled={readOnly}>
        <legend className="mb-1 text-[0.8125rem] font-medium">Color records</legend>
        {[
          ["none", "No colors"],
          ["by_select", "By a single select field"],
          ["by_conditions", "By conditions"],
        ].map(([v, l]) => (
          <label key={v} className="flex items-center gap-2 text-[0.8125rem]">
            <input type="radio" name="row-color-mode" checked={mode === v} onChange={() => setMode(v!)} /> {l}
          </label>
        ))}
      </fieldset>
      {rc?.mode === "by_select" && (
        <div>
          {selects.length === 0 ? (
            <p className="text-[0.8125rem] text-muted">This table has no single select field to color by.</p>
          ) : (
            <Select aria-label="Color by field" disabled={readOnly} value={rc.field_id} onChange={(e) => update((c) => setRowColor(c, { mode: "by_select", field_id: e.target.value }))}>
              {selects.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}
      {rc?.mode === "by_conditions" && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted">The first matching rule decides a record's color.</p>
          {rules.map((r, i) => (
            <div key={i} className="rounded-md border border-line p-2">
              <div className="mb-2 flex items-start justify-between gap-2">
                <ColorSwatchPicker label={`Color for rule ${i + 1}`} value={r.color} onChange={(color) => !readOnly && setRules(rules.map((x, k) => (k === i ? { ...x, color } : x)))} className="flex-1" />
                <IconButton label={`Remove rule ${i + 1}`} size="sm" noTooltip disabled={readOnly} onClick={() => setRules(rules.filter((_, k) => k !== i))}>
                  <X aria-hidden className="size-4" />
                </IconButton>
              </div>
              <FilterBuilder
                label={`Rule ${i + 1} condition`}
                value={r.filter.items.length ? r.filter : null}
                readOnly={readOnly}
                fields={table.fields}
                collaborators={props.collaborators}
                tables={props.schema.tables}
                emptyText="Add a condition to color matching records."
                onChange={(f) => setRules(rules.map((x, k) => (k === i ? { ...x, filter: f ?? { conjunction: "and", items: [] } } : x)))}
              />
            </div>
          ))}
          {!readOnly && (
            <Button size="sm" variant="secondary" onClick={() => setRules([...rules, { color: "green", filter: { conjunction: "and", items: [] } }])}>
              <Plus aria-hidden className="size-4" /> Add color rule
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The field of the first condition in a filter tree (for "Filtered by Who"). */
function firstConditionField(filter: Filter | null | undefined): string | null {
  for (const it of filter?.items ?? []) {
    const found = "items" in it ? firstConditionField(it) : it.field_id;
    if (found) return found;
  }
  return null;
}

/** "Who", "Who and 1 more": the fields a tool works on, for its label. */
function fieldsPhrase(table: Table, firstFieldId: string | null, count: number): string {
  const name = table.fields.find((f) => f.id === firstFieldId)?.name;
  if (!name) return `${count} field${count === 1 ? "" : "s"}`;
  return count > 1 ? `${name} and ${count - 1} more` : name;
}

export function ViewBar(props: ViewBarProps) {
  const { table, view, config, canConfigure, update, collaborators, schema, search, onSearchChange, searchOpen, onSearchOpenChange, searchInputRef } = props;
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const readOnly = !canConfigure;
  const why = view.locked ? "This view is locked. Only a creator can change it." : "You do not have permission to change this view.";
  // Colours are not part of the per-viewer override, so they stay read-only without save rights.
  const colorNote = readOnly ? why : undefined;
  // Filter, sort and group still work for this viewer alone; in the default grid they always do.
  const queryNote = view.is_default ? "In the default grid, filters, sorts and groups are only yours, on this device." : readOnly ? `${why} Your filters, sorts and groups apply only to you and are not saved.` : undefined;
  const hiddenCount = config.hidden_fields.filter((id) => id !== table.primary_field_id).length;
  const filterCount = countConditions(config.filter);
  const sortable = table.fields.filter(isSortable);
  const groupable = table.fields.filter(isGroupable);
  const heights: RowHeight[] = ["short", "medium", "tall", "extra_tall"];
  const rowColorActive = !!config.row_color && (config.row_color.mode === "by_select" || config.row_color.rules.length > 0);
  const showSearch = searchOpen || search !== "";
  // The default grid is plain: no colours (a view of its own can have them).
  const features = { group: true, color: true, rowHeight: true, csv: true, ...props.features, ...(view.is_default ? { color: false } : {}) };
  const csv = useExportCsv(view, props.timeZone);

  const filterWhat = filterCount > 0 ? fieldsPhrase(table, firstConditionField(config.filter), filterCount) : undefined;
  const sortWhat = config.sorts.length > 0 ? fieldsPhrase(table, config.sorts[0]!.field_id, config.sorts.length) : undefined;
  const groupWhat = config.groups.length > 0 ? fieldsPhrase(table, config.groups[0]!.field_id, config.groups.length) : undefined;
  const hideNoun = props.hideFieldsNoun ?? "Hide fields";
  const hiddenLabel = hiddenCount > 0 ? `${hiddenCount} hidden field${hiddenCount === 1 ? "" : "s"}` : hideNoun;

  const filterPanel = <FilterBuilder value={config.filter ?? null} onChange={(f) => update((c) => setFilter(c, f))} fields={table.fields.filter(isFilterable)} collaborators={collaborators} tables={schema.tables} readOnly={false} />;
  const sortPanel = (
    <SortListEditor
      noun="sort"
      items={config.sorts}
      fields={sortable}
      max={MAX_SORTS}
      readOnly={false}
      onAdd={(id) => update((c) => addSortLike(c, "sorts", id))}
      onUpdate={(i, p) => update((c) => updateSortLike(c, "sorts", i, p))}
      onRemove={(i) => update((c) => removeSortLike(c, "sorts", i))}
      onMove={(a, b) => update((c) => moveSortLike(c, "sorts", a, b))}
    />
  );
  const groupPanel = (
    <SortListEditor
      noun="group"
      items={config.groups}
      fields={groupable}
      max={MAX_GROUPS}
      readOnly={false}
      onAdd={(id) => update((c) => addSortLike(c, "groups", id))}
      onUpdate={(i, p) => update((c) => updateSortLike(c, "groups", i, p))}
      onRemove={(i) => update((c) => removeSortLike(c, "groups", i))}
      onMove={(a, b) => update((c) => moveSortLike(c, "groups", a, b))}
    />
  );
  const rowHeightPanel = (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-[0.8125rem] font-medium">Row height</legend>
      {heights.map((h) => (
        <label key={h} className="flex items-center gap-2 text-[0.8125rem]">
          <input type="radio" name="row-height" checked={config.row_height === h} onChange={() => update((c) => setRowHeight(c, h))} /> {ROW_HEIGHT_LABELS[h]}
        </label>
      ))}
    </fieldset>
  );

  // The tools in their row order. Each shows on the toolbar while there is room and moves into
  // More, from the right end first, when there is not (see toolbarFit.ts).
  const toolDefs: ToolDef[] = [
    { id: "filter", label: filterWhat ? `Filtered by ${filterWhat}` : "Filter", menuLabel: "Filter", icon: <FilterIcon aria-hidden />, value: filterWhat, active: filterCount > 0, note: queryNote, wide: true, panel: filterPanel },
    { id: "sort", label: sortWhat ? `Sorted by ${sortWhat}` : "Sort", menuLabel: "Sort", icon: <ListFilter aria-hidden />, value: sortWhat, active: config.sorts.length > 0, note: queryNote, wide: true, panel: sortPanel },
    ...(features.group ? [{ id: "group", label: groupWhat ? `Grouped by ${groupWhat}` : "Group", menuLabel: "Group", icon: <Group aria-hidden />, value: groupWhat, active: config.groups.length > 0, note: queryNote, wide: true, panel: groupPanel }] : []),
    { id: "hide", label: hiddenLabel, menuLabel: hideNoun, icon: <EyeOff aria-hidden />, value: hiddenCount > 0 ? `${hiddenCount} hidden` : undefined, active: hiddenCount > 0, panel: <HideFields table={table} config={config} update={update} /> },
    ...(features.color ? [{ id: "color", label: "Color", menuLabel: "Color", icon: <PaintBucket aria-hidden />, active: rowColorActive, note: colorNote, wide: true, panel: <ColorMenu table={table} config={config} update={update} props={{ collaborators, schema }} readOnly={readOnly} /> }] : []),
    ...(features.rowHeight ? [{ id: "row-height", label: "Row height", menuLabel: "Row height", icon: <Rows3 aria-hidden />, panel: rowHeightPanel }] : []),
  ];
  const toolEntry = (t: ToolDef): ToolEntry => ({ kind: "panel", id: t.id, label: t.menuLabel, icon: t.icon, value: t.value, active: t.active, note: t.note, wide: t.wide, panel: t.panel });
  // Always in More, however wide the window: the view type's switches, Add field and Download CSV.
  const toggles: ToolEntry[] = (props.moreToggles ?? []).map((t) => ({ kind: "toggle", id: t.id, label: t.label, icon: t.icon, checked: t.checked, disabled: t.disabled, onSelect: () => t.onToggle(!t.checked) }) as const);
  const actions: ToolEntry[] = [
    ...(props.onAddField ? [{ kind: "action", id: "add-field", label: "Add field", icon: <Plus aria-hidden />, onSelect: props.onAddField } as const] : []),
    ...(features.csv ? [{ kind: "action", id: "csv", label: csv.busy ? "Preparing…" : "Download CSV", icon: <Download aria-hidden />, busy: csv.busy, onSelect: () => void csv.run() } as const] : []),
  ];
  /** More's menu: the tools that did not fit, then the items that always live there. */
  const moreEntries = (overflow: ToolDef[]): ToolEntry[] => {
    const groups = [overflow.map(toolEntry), toggles, actions].filter((g) => g.length > 0);
    return groups.flatMap((g, i) => (i === 0 ? g : [{ kind: "separator", id: `sep-${i}` } as const, ...g]));
  };
  const activeTools = [filterCount > 0, config.sorts.length > 0, features.group && config.groups.length > 0, hiddenCount > 0, features.color && rowColorActive].filter(Boolean).length;

  const locked = view.locked && (
    <span className="inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5 text-xs text-muted" title="Locked view">
      <Lock aria-hidden className="size-3" /> Locked
    </span>
  );
  // In the default grid a filter of one's own is how it works, not a change left unsaved.
  const notSaved = props.hasLocalQuery && !canConfigure && !view.is_default && (
    <span role="status" className="inline-flex items-center gap-1 rounded bg-warning-soft px-1.5 py-0.5 text-xs" title="Your filters, sorts and groups are only applied for you">
      Not saved
      <button type="button" className="rounded px-1 font-medium underline hover:bg-hover" onClick={props.onResetLocalQuery}>
        Reset
      </button>
    </span>
  );
  const searchBox = showSearch ? (
    <div className="relative min-w-0 max-md:flex-1">
      <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <Input
        ref={searchInputRef}
        type="search"
        aria-label="Search records"
        placeholder="Search records"
        autoFocus
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onSearchChange("");
            onSearchOpenChange(false);
          }
        }}
        onBlur={() => {
          if (!search) onSearchOpenChange(false);
        }}
        className="h-9 w-full pl-8 md:w-56"
      />
    </div>
  ) : (
    <IconButton label="Search records (Ctrl+F)" onClick={() => onSearchOpenChange(true)} className="size-[38px] rounded-[10px] pointer-coarse:size-11">
      <Search aria-hidden className="size-[1.125rem]" />
    </IconButton>
  );

  if (!desktop) {
    const tools = moreEntries(toolDefs);
    return (
      <div role="toolbar" aria-label="View toolbar" className="flex flex-wrap items-center gap-1.5 bg-surface px-2.5 py-2">
        {!showSearch && <ViewSwitcher schema={schema} table={table} view={view} className="flex-1" />}
        {locked}
        {notSaved}
        <ToolMenu
          label="View tools"
          align="end"
          entries={tools}
          footer={
            (props.setting || props.extra) && (
              <div className="mt-1 flex flex-wrap items-center gap-1 border-t border-line px-1 pt-1.5">
                {props.setting}
                {props.extra}
              </div>
            )
          }
          trigger={
            <button
              type="button"
              aria-label={activeTools > 0 ? `Tools: filter, sort and more (${activeTools} on)` : "Tools: filter, sort and more"}
              className={cn("inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] hover:bg-hover data-[state=open]:bg-hover", activeTools > 0 ? "text-primary" : "text-muted")}
            >
              <SlidersHorizontal aria-hidden className="size-5" />
            </button>
          }
        />
        {searchBox}
        {props.onAdd && (
          // Within thumb reach and clear of the toolbar.
          <button
            type="button"
            aria-label="Add record"
            onClick={props.onAdd}
            className={cn(
              "fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-20 inline-flex h-12 items-center gap-1.5 rounded-full pl-4 pr-[18px] text-[0.9375rem] font-semibold shadow-pop transition-colors",
              addButtonClass,
            )}
          >
            <Plus aria-hidden className="size-5" /> Add
          </button>
        )}
      </div>
    );
  }

  return (
    <DesktopBar
      toolDefs={toolDefs}
      moreEntries={moreEntries}
      moreActive={toolDefs.some((t) => t.id === "color" && t.active)}
      switcher={<ViewSwitcher schema={schema} table={table} view={view} className="mr-1.5 max-w-[24rem] shrink" />}
      locked={locked}
      notSaved={notSaved}
      setting={props.setting}
      extra={props.extra}
      end={
        <>
          {searchBox}
          {props.onAdd && (
            <button
              type="button"
              aria-label="Add record"
              onClick={props.onAdd}
              className={cn("inline-flex h-[38px] items-center gap-1.5 rounded-[10px] pl-3.5 pr-4 text-[0.875rem] font-semibold transition-colors", addButtonClass)}
            >
              <Plus aria-hidden className="size-4" /> Add
            </button>
          )}
        </>
      }
    />
  );
}

/** A tool that can sit on the toolbar or, when the row is full, in More. */
interface ToolDef {
  id: string;
  /** On the toolbar: names what it does once in use ("Sorted by Who"). */
  label: string;
  /** In More, where the value shows beside the name instead. */
  menuLabel: string;
  icon: ReactNode;
  value?: string;
  active?: boolean;
  note?: string;
  wide?: boolean;
  panel: ReactNode;
}

const TOOL_GAP = 2;

/**
 * The desktop row. The tools that fit show as buttons; the rest go into More, from the right end
 * first, and come back as the window widens. An invisible copy of every tool and of More is
 * measured so the choice does not depend on what is showing at the moment.
 */
function DesktopBar({
  toolDefs,
  moreEntries,
  moreActive,
  switcher,
  locked,
  notSaved,
  setting,
  extra,
  end,
}: {
  toolDefs: ToolDef[];
  moreEntries: (overflow: ToolDef[]) => ToolEntry[];
  moreActive: boolean;
  switcher: ReactNode;
  locked: ReactNode;
  notSaved: ReactNode;
  setting?: ReactNode;
  extra?: ReactNode;
  end: ReactNode;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const settingRef = useRef<HTMLSpanElement>(null);
  const extraRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(toolDefs.length);
  // The least the tools' row may shrink to: the view's setting and extras plus More. Below that the
  // view picker gives way instead (it truncates), so More never slides under search and Add.
  const [floor, setFloor] = useState(0);
  const alwaysMore = moreEntries([]).length > 0;
  const labels = toolDefs.map((t) => t.label).join("\u0000");

  useLayoutEffect(() => {
    const area = areaRef.current;
    const measure = measureRef.current;
    if (!area || !measure) return;
    const fit = () => {
      const widths = Array.from(measure.children, (el) => (el as HTMLElement).offsetWidth);
      const more = widths.pop() ?? 0;
      const fixedParts = [settingRef.current?.offsetWidth ?? 0, extraRef.current?.offsetWidth ?? 0].filter((w) => w > 0);
      const fixed = fixedParts.reduce((a, b) => a + b, 0) + Math.max(0, fixedParts.length - 1) * TOOL_GAP;
      setVisible(visibleToolCount({ available: area.clientWidth, tools: widths, fixed, more, moreAlways: alwaysMore, gap: TOOL_GAP }));
      setFloor(fixed + (widths.length > 0 || alwaysMore ? more + (fixed > 0 ? TOOL_GAP : 0) : 0));
    };
    fit();
    const ro = new ResizeObserver(fit);
    for (const el of [area, measure, settingRef.current, extraRef.current]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [labels, alwaysMore]);

  const shown = toolDefs.slice(0, visible);
  const overflow = toolDefs.slice(visible);
  const entries = moreEntries(overflow);

  return (
    <div role="toolbar" aria-label="View toolbar" className="relative flex items-center gap-1.5 border-b border-line bg-surface px-4 py-2.5">
      {switcher}
      {locked}
      <div ref={areaRef} className="flex min-w-0 flex-1 items-center gap-0.5" style={floor > 0 ? { minWidth: floor } : undefined}>
        {setting && (
          <span ref={settingRef} className="inline-flex shrink-0">
            {setting}
          </span>
        )}
        {shown.map((t) => (
          <ToolButton key={t.id} label={t.label} active={t.active} note={t.note} wide={t.wide}>
            {t.panel}
          </ToolButton>
        ))}
        {extra && (
          <span ref={extraRef} className="inline-flex shrink-0">
            {extra}
          </span>
        )}
        {entries.length > 0 && (
          <ToolMenu
            label="More view tools"
            entries={entries}
            trigger={
              <button type="button" className={cn(toolClass, "shrink-0 gap-1 pr-2", (moreActive || overflow.some((t) => t.active)) && toolActiveClass)}>
                More <ChevronDown aria-hidden className="size-3.5" />
              </button>
            }
          />
        )}
      </div>
      {notSaved}
      <div className="flex shrink-0 items-center gap-1.5">{end}</div>
      {/* Out of sight and out of the accessibility tree: only here to be measured. */}
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex whitespace-nowrap">
        {toolDefs.map((t) => (
          <span key={t.id} className={toolClass}>
            {t.label}
          </span>
        ))}
        <span className={cn(toolClass, "gap-1 pr-2")}>
          More <ChevronDown className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

