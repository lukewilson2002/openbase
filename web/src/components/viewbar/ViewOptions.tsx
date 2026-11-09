/**
 * View options (COL-6): the one control that holds every setting of a view. A "View options" button opens a
 * 360 px popover anchored to the right on a desktop, or a bottom sheet on a phone (PH-3). Its sections, in order:
 *
 *   1. Layout: seven tiles, and under them the shown layout's own settings (`layoutSettings`).
 *   2. Sort, Group, Color and Properties: rows that say their current value and open a screen of their own
 *      inside the same popover or sheet, with a Back button.
 *   3. Row height and Wrap headers (a grid's).
 *   4. A footer: the layout's switches (`toggles`), Add property for creators and Download CSV.
 *
 * Everything here writes the person's draft (COL-5) through `update`, except a form's own settings, which the form
 * builder saves as they are made. This button sits at the right end of the filter bar (ViewFilterBar).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Download, Plus, SlidersHorizontal } from "lucide-react";
import type { BaseSchema, Collaborator, RowHeight, Table, View, ViewConfig, ViewType } from "@/api/types";
import { useExportCsv } from "@/components/csv/ExportCsvButton";
import { FieldDialog } from "@/components/fields/FieldDialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet } from "@/components/ui/sheet";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { atLeast } from "@/lib/roles";
import { SegmentedSwitch } from "@/views/common/SegmentedSwitch";
import { LayoutTiles } from "./LayoutTiles";
import { PropertiesEditor } from "./PropertiesEditor";
import { RowColorEditor } from "./RowColorEditor";
import { SortListEditor } from "./SortListEditor";
import { MAX_GROUPS, MAX_SORTS, ROW_HEIGHT_LABELS, addSortLike, isGroupable, isSortable, moveSortLike, removeSortLike, setRowHeight, updateSortLike } from "./config";
import { colorSummary, groupSummary, propertiesSummary, sortSummary } from "./optionsSummary";

/** A switch of the footer that belongs to the layout ("Hide empty stacks", "Fold all groups"). */
export interface LayoutToggle {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (on: boolean) => void;
}

/** Which sections a layout has. Everything is on unless a layout switches it off. */
export interface ViewOptionsFeatures {
  sort?: boolean;
  group?: boolean;
  color?: boolean;
  properties?: boolean;
  /** Row height and Wrap headers: a grid's. */
  rowHeight?: boolean;
  addProperty?: boolean;
  csv?: boolean;
}

export interface ViewOptionsProps {
  schema: BaseSchema;
  table: Table;
  view: Pick<View, "id" | "name">;
  role: string;
  config: ViewConfig;
  update: (mutate: (c: ViewConfig) => ViewConfig) => void;
  collaborators: readonly Collaborator[];
  /** The layout being shown and how to show the same records in another one (a draft). */
  layout: ViewType;
  onLayoutChange: (type: ViewType) => void;
  features?: ViewOptionsFeatures;
  /** The view has a draft: its filter, sorts and properties are not saved yet, and Download CSV is the saved view's. */
  hasDraft?: boolean;
  /** The shown layout's own settings, under the tiles (what a board stacks by, a calendar's dates). A function gets `close`, for a button that opens something else. */
  layoutSettings?: ReactNode | ((close: () => void) => ReactNode);
  /** Settings that sit with the properties: the description property, how many properties a card shows. */
  propertySettings?: ReactNode;
  toggles?: readonly LayoutToggle[];
  /** Viewer's IANA zone, used by the CSV export for dates. */
  timeZone?: string;
}

type Screen = "root" | "sort" | "group" | "color" | "properties";

const SCREEN_TITLES: Record<Exclude<Screen, "root">, string> = { sort: "Sort", group: "Group", color: "Color", properties: "Properties" };

const ROW_HEIGHTS: RowHeight[] = ["short", "medium", "tall", "extra_tall"];

/**
 * Picking a layout swaps the whole view component, and with it this one. The next one opens at once, on the new
 * layout's settings, so the person can carry on where they were instead of finding the panel closed.
 */
const carry = { open: false };

/** Forgets a hand-over that no layout took (tests, where a layout switch does not swap the component). */
export function forgetViewOptionsHandOver(): void {
  carry.open = false;
}

export function ViewOptions(props: ViewOptionsProps) {
  const { schema, table, view, role, config, update, collaborators, layout, features, hasDraft = false, layoutSettings, propertySettings, toggles = [], timeZone } = props;
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [open, setOpen] = useState(carry.open);
  const [screen, setScreen] = useState<Screen>("root");
  const [adding, setAdding] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<Partial<Record<Screen, HTMLButtonElement | null>>>({});
  const cameFrom = useRef<Screen | null>(null);
  const csv = useExportCsv(view, timeZone);

  const has = { sort: true, group: true, color: true, properties: true, rowHeight: false, addProperty: true, csv: true, ...features };
  const canAdd = has.addProperty && atLeast(role, "creator");

  useEffect(() => {
    carry.open = false;
  }, []);

  // Back from a screen puts focus on the row that opened it.
  useEffect(() => {
    if (screen !== "root" || !cameFrom.current) return;
    rowRefs.current[cameFrom.current]?.focus();
    cameFrom.current = null;
  }, [screen]);

  // The dialog's opener (a footer button) is gone by the time it closes: focus goes back to the button that opened the panel.
  const wasAdding = useRef(false);
  useEffect(() => {
    if (wasAdding.current && !adding) {
      const id = window.setTimeout(() => {
        if (document.activeElement === document.body) trigger.current?.focus();
      }, 50);
      return () => window.clearTimeout(id);
    }
    wasAdding.current = adding;
  }, [adding]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setScreen("root");
      cameFrom.current = null;
    }
  };
  const close = () => onOpenChange(false);
  const goTo = (to: Exclude<Screen, "root">) => {
    cameFrom.current = to;
    setScreen(to);
  };
  const chooseLayout = (type: ViewType) => {
    carry.open = true;
    // A layout that never mounts its own View options must not leave the next screen's open.
    window.setTimeout(forgetViewOptionsHandOver, 2000);
    props.onLayoutChange(type);
  };

  const sortable = table.fields.filter(isSortable);
  const groupable = table.fields.filter(isGroupable);

  const rows: { screen: Exclude<Screen, "root">; value: string }[] = [
    ...(has.sort ? [{ screen: "sort" as const, value: sortSummary(table.fields, config.sorts) }] : []),
    ...(has.group ? [{ screen: "group" as const, value: groupSummary(table.fields, config.groups) }] : []),
    ...(has.color ? [{ screen: "color" as const, value: colorSummary(table.fields, config.row_color) }] : []),
    ...(has.properties ? [{ screen: "properties" as const, value: propertiesSummary(table, config) }] : []),
  ];

  const editor = (s: Exclude<Screen, "root">): ReactNode => {
    switch (s) {
      case "sort":
        return (
          <SortListEditor
            noun="sort"
            items={config.sorts}
            fields={sortable}
            max={MAX_SORTS}
            onAdd={(id) => update((c) => addSortLike(c, "sorts", id))}
            onUpdate={(i, p) => update((c) => updateSortLike(c, "sorts", i, p))}
            onRemove={(i) => update((c) => removeSortLike(c, "sorts", i))}
            onMove={(a, b) => update((c) => moveSortLike(c, "sorts", a, b))}
          />
        );
      case "group":
        return (
          <SortListEditor
            noun="group"
            items={config.groups}
            fields={groupable}
            max={MAX_GROUPS}
            onAdd={(id) => update((c) => addSortLike(c, "groups", id))}
            onUpdate={(i, p) => update((c) => updateSortLike(c, "groups", i, p))}
            onRemove={(i) => update((c) => removeSortLike(c, "groups", i))}
            onMove={(a, b) => update((c) => moveSortLike(c, "groups", a, b))}
          />
        );
      case "color":
        return <RowColorEditor schema={schema} table={table} config={config} update={update} collaborators={collaborators} />;
      case "properties":
        return (
          <PropertiesEditor table={table} config={config} update={update}>
            {propertySettings}
          </PropertiesEditor>
        );
    }
  };

  const root = (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="view-options-layout" className="flex flex-col gap-3">
        <h3 id="view-options-layout" className="text-label font-semibold text-muted">
          Layout
        </h3>
        <LayoutTiles layout={layout} onChange={chooseLayout} />
        {layoutSettings && <div className="flex flex-col gap-3">{typeof layoutSettings === "function" ? layoutSettings(close) : layoutSettings}</div>}
      </section>

      {rows.length > 0 && (
        <ul className="-mx-1 flex flex-col border-t border-line pt-2">
          {rows.map((r) => (
            <li key={r.screen}>
              <button
                type="button"
                ref={(el) => {
                  rowRefs.current[r.screen] = el;
                }}
                onClick={() => goTo(r.screen)}
                className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-fg hover:bg-hover max-md:min-h-control-touch"
              >
                <span className="font-medium">{SCREEN_TITLES[r.screen]}</span>
                {/* The space keeps the row's name reading "Sort Name, A to Z" and not "SortName". */}{" "}
                <span className="min-w-0 flex-1 truncate text-right text-muted">{r.value}</span>
                <Icon icon={ChevronRight} className="text-faint" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {has.rowHeight && (
        <section aria-labelledby="view-options-height" className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 id="view-options-height" className="text-label font-semibold text-muted">
            Row height
          </h3>
          <SegmentedSwitch
            label="Row height"
            size="lg"
            value={config.row_height}
            options={ROW_HEIGHTS.map((h) => ({ value: h, label: ROW_HEIGHT_LABELS[h] }))}
            onChange={(h) => update((c) => setRowHeight(c, h))}
          />
          <Switch className="min-h-control-md max-md:min-h-control-touch" label="Wrap headers" checked={config.wrap_headers} onCheckedChange={(on) => update((c) => ({ ...c, wrap_headers: on }))} />
        </section>
      )}

      {(toggles.length > 0 || canAdd || has.csv) && (
        <div className="-mx-1 flex flex-col gap-0.5 border-t border-line pt-2">
          {toggles.map((t) => (
            <Switch key={t.id} className="min-h-10 px-2 max-md:min-h-control-touch" label={t.label} checked={t.checked} disabled={t.disabled} onCheckedChange={t.onToggle} />
          ))}
          {canAdd && (
            <Button
              variant="ghost"
              className="justify-start px-2"
              onClick={() => {
                close();
                setAdding(true);
              }}
            >
              <Icon icon={Plus} /> Add property
            </Button>
          )}
          {has.csv && (
            <Button
              variant="ghost"
              className="justify-start px-2"
              disabled={csv.busy}
              // The file holds the saved view; a draft is on this device only, so say it is not in it.
              aria-describedby={hasDraft ? "csv-saved-note" : undefined}
              onClick={() => {
                void csv.run();
                close();
              }}
            >
              <Icon icon={Download} /> {csv.busy ? "Preparing…" : "Download CSV"}
              {hasDraft && (
                <span id="csv-saved-note" aria-hidden className="ml-auto pl-2 text-meta font-normal text-muted">
                  Saved view only
                </span>
              )}
            </Button>
          )}
        </div>
      )}
    </div>
  );

  const body =
    screen === "root" ? (
      root
    ) : (
      <div className="flex flex-col gap-3">
        <div className="-ml-1 flex items-center gap-1">
          <IconButton label="Back to View options" size="sm" noTooltip autoFocus onClick={() => setScreen("root")}>
            <Icon icon={ArrowLeft} />
          </IconButton>
          <h3 className="text-h3">{SCREEN_TITLES[screen]}</h3>
        </div>
        {editor(screen)}
      </div>
    );

  const button = desktop ? (
    <Button ref={trigger} variant="secondary">
      <Icon icon={SlidersHorizontal} /> View options
    </Button>
  ) : (
    <IconButton ref={trigger} variant="secondary" label="View options" noTooltip aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <Icon icon={SlidersHorizontal} />
    </IconButton>
  );

  return (
    <>
      {desktop ? (
        <Popover open={open} onOpenChange={onOpenChange}>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
          <PopoverContent align="end" aria-label="View options" className="max-h-[min(44rem,var(--ob-avail))] w-panel max-w-[calc(100vw-1rem)] p-3">
            {screen === "root" && <h2 className="mb-3 text-ui font-semibold">View options</h2>}
            {body}
          </PopoverContent>
        </Popover>
      ) : (
        <>
          {button}
          <Sheet open={open} onOpenChange={onOpenChange} title="View options">
            {body}
          </Sheet>
        </>
      )}
      {adding && <FieldDialog state={{ mode: "create" }} schema={schema} table={table} onOpenChange={(o) => !o && setAdding(false)} />}
    </>
  );
}
