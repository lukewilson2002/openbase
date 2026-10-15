/**
 * The grid toolbar: hide fields, filter, group, sort, colour, row height, search, share.
 * Every change is a pure mutation of the view config (see ./config.ts) applied through
 * `update`, which persists the full config with PATCH /api/views/{id}. People who cannot save
 * the view (viewers and commenters, editors on locked views) can still filter, sort and group
 * for themselves: `update` then keeps those as a local override that is sent with each query
 * and marked "not saved" here. Colours stay read-only for them.
 *
 * The tools fold into one "Tools" button (remembered per device; folded by default on phones,
 * where they would take several rows), and views that add records get a primary "Add" at the end,
 * floating at the bottom corner on phones.
 */
import { useState, type RefObject } from "react";
import { ChevronsLeft, EyeOff, Filter, Group, ListFilter, Lock, PaintBucket, Plus, Rows3, Search, Share2, SlidersHorizontal, X } from "lucide-react";
import type { BaseSchema, Collaborator, RowColor, RowHeight, Table, View, ViewConfig } from "@/api/types";
import { ExportCsvButton } from "@/components/csv/ExportCsvButton";
import { ShareViewDialog } from "@/components/share/LazyShareViewDialog";
import { canShareView } from "@/components/share/shareView";
import { Button } from "@/components/ui/button";
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import { Switch } from "@/components/ui/checkbox";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Select } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { countConditions, isFilterable } from "@/lib/cells/filters";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { FilterBuilder } from "./FilterBuilder";
import { SortListEditor } from "./SortListEditor";
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
  onAddField?: () => void;
  canManageFields: boolean;
  /** Toolbar sections a view type does not use can be switched off (all on by default). */
  features?: { group?: boolean; color?: boolean; rowHeight?: boolean; shareView?: boolean; csv?: boolean };
  /** Viewer's IANA zone, used by the CSV export for dates. */
  timeZone?: string;
  /** Label of the hide-fields menu ("Hide fields" in the grid, "Card fields" on card views). */
  hideFieldsNoun?: string;
  /** View-type specific settings (stack field, date fields...), shown before the search box. */
  extra?: React.ReactNode;
  /** Adds a record (the toolbar's primary "Add"); omitted where the view adds records its own way or the viewer cannot. */
  onAdd?: () => void;
}

export const TOOLS_KEY = "ob-tools-collapsed";

function readToolsCollapsed(): boolean | null {
  try {
    const raw = localStorage.getItem(TOOLS_KEY);
    return raw === "1" ? true : raw === "0" ? false : null;
  } catch {
    return null;
  }
}

/** Folded or not: the person's last choice on this device, else folded on phones only. */
function useToolsCollapsed(desktop: boolean): [boolean, (collapsed: boolean) => void] {
  const [stored, setStored] = useState(readToolsCollapsed);
  const set = (collapsed: boolean) => {
    setStored(collapsed);
    try {
      localStorage.setItem(TOOLS_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage unavailable (private mode, quota): the choice lasts for this page view */
    }
  };
  return [stored ?? !desktop, set];
}

function ToolButton({ icon, label, active, children, disabledNote, wide }: { icon: React.ReactNode; label: string; active?: boolean; children: React.ReactNode; disabledNote?: string; wide?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[0.8125rem] font-medium hover:bg-hover pointer-coarse:h-10 pointer-coarse:px-2.5",
            active ? "bg-primary-soft text-primary hover:bg-primary-soft" : "text-fg",
          )}
        >
          {icon}
          <span className="hidden sm:inline">{label}</span>
          <span className="sr-only sm:hidden">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn("max-h-[min(34rem,80dvh)] overflow-y-auto p-3", wide ? "w-[min(46rem,calc(100vw-1.5rem))]" : "w-[min(30rem,calc(100vw-1.5rem))]")}>
        {disabledNote && <p className="mb-2 rounded bg-warning-soft px-2 py-1 text-xs">{disabledNote}</p>}
        {children}
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

export function ViewBar(props: ViewBarProps) {
  const { table, view, config, canConfigure, update, collaborators, schema, search, onSearchChange, searchOpen, onSearchOpenChange, searchInputRef } = props;
  const readOnly = !canConfigure;
  const why = view.locked ? "This view is locked. Only a creator can change it." : "You do not have permission to change this view.";
  // Colours are not part of the per-viewer override, so they stay read-only without save rights.
  const colorNote = readOnly ? why : undefined;
  // Filter, sort and group still work for this viewer alone.
  const queryNote = readOnly ? `${why} Your filters, sorts and groups apply only to you and are not saved.` : undefined;
  const hiddenCount = config.hidden_fields.filter((id) => id !== table.primary_field_id).length;
  const filterCount = countConditions(config.filter);
  const sortable = table.fields.filter(isSortable);
  const groupable = table.fields.filter(isGroupable);
  const heights: RowHeight[] = ["short", "medium", "tall", "extra_tall"];
  const rowColorActive = !!config.row_color && (config.row_color.mode === "by_select" || config.row_color.rules.length > 0);
  const showSearch = searchOpen || search !== "";
  const features = { group: true, color: true, rowHeight: true, shareView: true, csv: true, ...props.features };
  const [sharing, setSharing] = useState(false);
  const mayShare = atLeast(props.role, "creator");
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [collapsed, setCollapsed] = useToolsCollapsed(desktop);
  const activeTools = [hiddenCount > 0, filterCount > 0, features.group && config.groups.length > 0, config.sorts.length > 0, features.color && rowColorActive].filter(Boolean).length;

  return (
    <div role="toolbar" aria-label="View toolbar" className="flex flex-wrap items-center gap-0.5 bg-surface px-2 py-1">
      {view.locked && (
        <span className="mr-1 inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5 text-xs text-muted" title="Locked view">
          <Lock aria-hidden className="size-3" /> Locked
        </span>
      )}
      {collapsed ? (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setCollapsed(false)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[0.8125rem] font-medium hover:bg-hover pointer-coarse:h-10 pointer-coarse:px-2.5",
            activeTools > 0 ? "bg-primary-soft text-primary hover:bg-primary-soft" : "text-fg",
          )}
        >
          <SlidersHorizontal aria-hidden className="size-4" />
          {activeTools > 0 ? `Tools · ${activeTools} on` : "Tools"}
        </button>
      ) : (
        <>
          <ToolButton icon={<EyeOff aria-hidden className="size-4" />} label={hiddenCount > 0 ? `${hiddenCount} hidden field${hiddenCount === 1 ? "" : "s"}` : (props.hideFieldsNoun ?? "Hide fields")} active={hiddenCount > 0}>
            <HideFields table={table} config={config} update={update} />
          </ToolButton>

          <ToolButton icon={<Filter aria-hidden className="size-4" />} label={filterCount > 0 ? `${filterCount} filter${filterCount === 1 ? "" : "s"}` : "Filter"} active={filterCount > 0} disabledNote={queryNote} wide>
            <FilterBuilder value={config.filter ?? null} onChange={(f) => update((c) => setFilter(c, f))} fields={table.fields.filter(isFilterable)} collaborators={collaborators} tables={schema.tables} readOnly={false} />
          </ToolButton>

          {features.group && (
          <ToolButton icon={<Group aria-hidden className="size-4" />} label={config.groups.length > 0 ? `Grouped by ${config.groups.length} field${config.groups.length === 1 ? "" : "s"}` : "Group"} active={config.groups.length > 0} disabledNote={queryNote} wide>
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
          </ToolButton>
          )}

          <ToolButton icon={<ListFilter aria-hidden className="size-4" />} label={config.sorts.length > 0 ? `Sorted by ${config.sorts.length} field${config.sorts.length === 1 ? "" : "s"}` : "Sort"} active={config.sorts.length > 0} disabledNote={queryNote} wide>
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
          </ToolButton>

          {features.color && (
          <ToolButton icon={<PaintBucket aria-hidden className="size-4" />} label="Color" active={rowColorActive} disabledNote={colorNote} wide>
            <ColorMenu table={table} config={config} update={update} props={{ collaborators, schema }} readOnly={readOnly} />
          </ToolButton>
          )}

          {props.extra}

          {features.rowHeight && (
          <ToolButton icon={<Rows3 aria-hidden className="size-4" />} label="Row height">
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-[0.8125rem] font-medium">Row height</legend>
              {heights.map((h) => (
                <label key={h} className="flex items-center gap-2 text-[0.8125rem]">
                  <input type="radio" name="row-height" checked={config.row_height === h} onChange={() => update((c) => setRowHeight(c, h))} /> {ROW_HEIGHT_LABELS[h]}
                </label>
              ))}
            </fieldset>
          </ToolButton>
          )}

          <button
            type="button"
            aria-label="Hide tools"
            aria-expanded
            title="Hide tools"
            onClick={() => setCollapsed(true)}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[0.8125rem] text-muted hover:bg-hover hover:text-fg pointer-coarse:h-10"
          >
            <ChevronsLeft aria-hidden className="size-4" />
            {/* Spelled out only where the toolbar has room to spare beside the base menu. */}
            <span aria-hidden className="hidden 2xl:inline">
              Hide tools
            </span>
          </button>
        </>
      )}

      {props.hasLocalQuery && !canConfigure && (
        <span role="status" className="ml-1 inline-flex items-center gap-1 rounded bg-warning-soft px-1.5 py-0.5 text-xs" title="Your filters, sorts and groups are only applied for you">
          Not saved
          <button type="button" className="rounded px-1 font-medium underline hover:bg-hover" onClick={props.onResetLocalQuery}>
            Reset
          </button>
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        {props.canManageFields && props.onAddField && (
          <Button size="sm" variant="ghost" onClick={props.onAddField} className="hidden md:inline-flex">
            <Plus aria-hidden className="size-4" /> Add field
          </Button>
        )}
        {showSearch ? (
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-2 top-2 size-4 text-muted" />
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
              className="h-8 w-56 pl-8"
            />
          </div>
        ) : (
          <IconButton label="Search records (Ctrl+F)" onClick={() => onSearchOpenChange(true)}>
            <Search aria-hidden className="size-4" />
          </IconButton>
        )}
        {features.csv && <ExportCsvButton view={view} timeZone={props.timeZone} />}
        {features.shareView && mayShare && (
          <>
            <Button size="sm" variant="secondary" disabled={!canShareView(props.role, view)} title={view.personal ? "Personal views cannot be shared" : "Create public links to this view"} onClick={() => setSharing(true)}>
              <Share2 aria-hidden className="size-4" /> <span className="max-sm:sr-only">Share view</span>
            </Button>
            {sharing && <ShareViewDialog open onOpenChange={setSharing} view={view} table={table} />}
          </>
        )}
        {props.onAdd && desktop && (
          <Button size="sm" variant="primary" aria-label="Add record" onClick={props.onAdd} className="ml-1">
            <Plus aria-hidden className="size-4" /> Add
          </Button>
        )}
      </div>
      {props.onAdd && !desktop && (
        // Within thumb reach and clear of the toolbar, like the workspace page's "New base".
        <button
          type="button"
          aria-label="Add record"
          onClick={props.onAdd}
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-20 inline-flex h-[52px] items-center gap-2 rounded-full bg-primary px-5 text-[0.9375rem] font-semibold text-primary-fg shadow-pop transition-colors hover:bg-primary-hover"
        >
          <Plus aria-hidden className="size-5" /> Add
        </button>
      )}
    </div>
  );
}

