/**
 * Gallery view: a responsive grid of record cards (cover image, title, visible fields) loaded
 * page by page as you scroll.
 *
 * Keyboard: Tab enters the grid once (one card is the tab stop); the arrow keys, Home and End move
 * between cards; Enter opens a card, Space selects it, Delete deletes it (or the selection), and
 * Alt with an arrow key moves it in the view's manual order. Ctrl/Cmd-click and Shift-click select
 * several cards for the bar at the bottom; right-click opens a card's menu. With no sort, a card
 * can also be dragged to a new place.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check } from "lucide-react";
import type { Field, TableRecord, ViewConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { TOUCH_HOLD_MS, TOUCH_HOLD_TOLERANCE_PX } from "@/lib/holdToDrag";
import { useHoldMenu } from "@/lib/holdMenu";
import type { FormatCtx } from "@/lib/cells/format";
import { CardBody } from "../common/CardBody";
import { cardFields, cardTitle, fieldsToShow, itemsLabel } from "../common/cardFields";
import { DescriptionSelect, setDescriptionField, useDescriptionField } from "../common/description";
import { EmptyRecords } from "../common/EmptyRecords";
import { RecordMenu } from "../common/RecordMenu";
import { SelectionBar } from "../common/SelectionBar";
import { useRecordSelection, type RecordSelection } from "../common/useRecordSelection";
import { useRovingFocus, type RovingItemProps } from "../common/useRovingFocus";
import { useViewSetup } from "../common/useViewSetup";
import { FieldSelect } from "../common/FieldSelect";
import { ViewFrame } from "../common/ViewFrame";
import type { ViewProps } from "../types";
import { neighbourCard, onLastRow, survivorAfterDelete } from "./galleryNav";
import { useGalleryData } from "./useGalleryData";

/** Fields one card shows (those with a value, in the view's order); a "+N more" says how many it left out. */
export const GALLERY_FIELD_LIMIT = 5;

export default function GalleryView(props: ViewProps) {
  return <GalleryInner key={props.view.id} {...props} />;
}

function setGallery(c: ViewConfig, patch: Partial<ViewConfig["gallery"]>): ViewConfig {
  return { ...c, gallery: { ...c.gallery, ...patch } };
}

interface MenuState {
  id: string;
  anchor: { x: number; y: number; width: number; height: number };
}

function GalleryInner(props: ViewProps) {
  const setup = useViewSetup(props);
  const { table, view, config, cfg, writes, actions } = setup;
  const attachmentFields = useMemo(() => table.fields.filter((f) => f.type === "attachment"), [table.fields]);
  const coverField = attachmentFields.find((f) => f.id === config.gallery.cover_field_id);
  const crop = config.gallery.cover_crop;
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const { candidates: descriptionFields, field: descriptionField } = useDescriptionField(table, config);
  // The description sits under the title, so it does not repeat as a field.
  const fields = useMemo(() => cardFields(table, config, new Set([coverField?.id ?? "", descriptionField?.id ?? ""])), [table, config, coverField?.id, descriptionField?.id]);

  const data = useGalleryData({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone: setup.timeZone, transient: setup.transient });

  // Infinite scroll: load the next page when the sentinel below the cards comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMore, loadMore } = data;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, data.records.length]);

  const recordIds = useMemo(() => data.records.map((r) => r.id), [data.records]);
  const sel = useRecordSelection(recordIds);
  const roving = useRovingFocus(recordIds);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Cards can be put in a new place only where the view keeps them in manual order.
  const reorderable = setup.canEdit && cfg.queryConfig.sorts.length === 0;

  // --- Moving cards ---------------------------------------------------------------------------
  const moveCard = useCallback(
    async (id: string, target: { beforeId?: string; afterId?: string }) => {
      if (reorderable) await writes.move(id, target, { label: "Move card" });
    },
    [reorderable, writes],
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // A finger must rest on a card first: moving straight away is a swipe that scrolls the page.
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_HOLD_MS, tolerance: TOUCH_HOLD_TOLERANCE_PX } }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = recordIds.indexOf(String(active.id));
    const to = recordIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    void moveCard(String(active.id), to > from ? { afterId: String(over.id) } : { beforeId: String(over.id) });
  };

  const recordsOf = (ids: readonly string[]): TableRecord[] => data.records.filter((r) => ids.includes(r.id));
  const duplicateIds = (ids: readonly string[]) => void actions.duplicate(recordsOf(ids), ids.length > 1 ? sel.clear : undefined);

  // --- Keys -----------------------------------------------------------------------------------
  // Focus stays in the gallery when cards go: the card after them, else the one before, takes it over.
  const deleteFromKeys = (ids: readonly string[], onDone?: () => void) => {
    if (!setup.canEdit) return;
    const keep = survivorAfterDelete(recordIds, new Set(ids));
    if (keep) roving.focusKey(keep);
    actions.requestDelete(ids, onDone);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (sel.handleKeyDown(e, { onDelete: () => deleteFromKeys(sel.ids, sel.clear) })) return;
    const card = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-record-id]") : null;
    // Keys pressed in a link or button inside a card belong to it, not to the card.
    if (!card || e.target !== card) return;
    const id = card.dataset.recordId!;
    const at = recordIds.indexOf(id);
    if (e.key === "Enter") {
      e.preventDefault();
      setup.openRecord(id);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      sel.toggle(id);
      return;
    }
    if (e.key === "Delete" && setup.canEdit) {
      e.preventDefault();
      deleteFromKeys([id]);
      return;
    }
    const cards = [...(roving.containerRef.current?.querySelectorAll<HTMLElement>("[data-record-id]") ?? [])];
    const boxes = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width };
    });
    const to = neighbourCard(boxes, at, e.key);
    if (e.altKey && to !== null && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
      // Alt with an arrow moves the card itself to where focus would have gone.
      e.preventDefault();
      const other = recordIds[to];
      if (other && reorderable) void moveCard(id, to > at ? { afterId: other } : { beforeId: other }).then(() => roving.focusKey(id));
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (to !== null) {
      e.preventDefault();
      roving.focusKey(recordIds[to]!);
    } else if (e.key === "ArrowDown" || e.key === "End") {
      // The last row: more cards may be on their way.
      e.preventDefault();
      if (hasMore && onLastRow(boxes, at)) loadMore();
    } else if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
      e.preventDefault();
    }
  };

  const menuRecordIds = menu ? (sel.has(menu.id) ? sel.ids : [menu.id]) : [];
  const menuIndex = menu ? recordIds.indexOf(menu.id) : -1;
  const menuRecord = menu ? data.records.find((r) => r.id === menu.id) : undefined;
  const menuTitle = menuRecord ? cardTitle(primary, menuRecord, setup.format) : "Record";

  const settings = (
    <>
      <FieldSelect
        label="Cover"
        fields={attachmentFields}
        value={coverField?.id ?? ""}
        noneLabel="No cover"
        onChange={(id) => cfg.update((c) => setGallery(c, { cover_field_id: id }))}
        hint={attachmentFields.length === 0 ? "Add an attachment property to show pictures on the cards." : "Cards show the first image of this property, when they have one."}
      />
      <div className="flex flex-col gap-1">
        <Checkbox label="Crop cover images" checked={crop} disabled={!coverField} onCheckedChange={(on) => cfg.update((c) => setGallery(c, { cover_crop: on }))} />
        <p className="text-meta text-muted">
          {coverField ? "On, a picture fills its space and loses its edges; off, the whole picture shows." : "Choose a cover above to set how pictures fit."}
        </p>
      </div>
    </>
  );
  const propertySettings = <DescriptionSelect candidates={descriptionFields} field={descriptionField} onChange={(id) => cfg.update((c) => setDescriptionField(c, id))} />;

  return (
    <ViewFrame
      setup={setup}
      layout="bare"
      features={{ group: false, rowHeight: false }}
      layoutSettings={settings}
      propertySettings={propertySettings}
      onAdd={setup.canEdit ? () => void setup.addRecord() : undefined}
      footer={
        data.loading ? undefined : (
          <>
            <span aria-live="polite">
              {data.total > data.records.length ? `${data.records.length.toLocaleString()} of ${itemsLabel(data.total)}` : itemsLabel(data.total)}
              {setup.debouncedSearch ? " found" : ""}
            </span>
          </>
        )
      }
    >
      <div className="p-3 pb-2.5 md:p-4 md:pb-2.5">
        {data.loading ? (
          <div className="flex justify-center pt-16">
            <Spinner className="size-5" label="Loading records" />
          </div>
        ) : data.error && data.records.length === 0 ? (
          <p role="alert" className="pt-16 text-center text-label text-muted">
            Could not load records: {data.error.message}
          </p>
        ) : (
          <>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={recordIds} strategy={rectSortingStrategy} disabled={!reorderable}>
                <div ref={roving.containerRef} role="list" aria-label="Records" onKeyDown={onKeyDown} className="grid items-start gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
                  {data.records.map((rec) => (
                    <GalleryCard
                      key={rec.id}
                      record={rec}
                      primary={primary}
                      fields={fields}
                      coverField={coverField}
                      descriptionField={descriptionField}
                      crop={crop}
                      format={setup.format}
                      emails={setup.emails}
                      color={data.colors[rec.id]}
                      sel={sel}
                      nav={roving.itemProps(rec.id)}
                      draggable={reorderable}
                      onOpen={() => setup.openRecord(rec.id)}
                      onMenu={(anchor) => setMenu({ id: rec.id, anchor })}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            {data.records.length === 0 && (
              // Cards sit straight on the page, so the empty state gets a card of its own to sit in.
              <div className="rounded-lg border border-line bg-surface">
                <EmptyRecords table={table} filtered={setup.filtered} onAdd={setup.canEdit ? () => void setup.addRecord() : undefined} onReset={setup.resetFilters} />
              </div>
            )}
            <div ref={sentinel} className={cn("flex items-center justify-center", (data.hasMore || data.loadingMore) && "h-16")}>
              {data.loadingMore ? (
                <Spinner className="size-4" label="Loading more" />
              ) : (
                data.hasMore && (
                  <Button size="sm" onClick={data.loadMore}>
                    Load more
                  </Button>
                )
              )}
            </div>
            {/* The cards scroll inside the page, so the bar sticks to the bottom of what is on screen. */}
            {sel.count > 0 && (
              <div className="sticky bottom-0 z-20 h-0">
                <SelectionBar count={sel.count} onDuplicate={() => duplicateIds(sel.ids)} onDelete={() => actions.requestDelete(sel.ids, sel.clear)} onClear={sel.clear} />
              </div>
            )}
          </>
        )}
      </div>
      <RecordMenu
        anchor={menu?.anchor ?? null}
        title={menuTitle}
        onClose={() => setMenu(null)}
        count={menuRecordIds.length}
        canEdit={setup.canEdit}
        selected={!!menu && sel.has(menu.id)}
        onOpen={() => menu && setup.openRecord(menu.id)}
        onToggleSelect={() => menu && sel.toggle(menu.id)}
        onDuplicate={() => duplicateIds(menuRecordIds)}
        onDelete={() => actions.requestDelete(menuRecordIds, sel.clear)}
        onMoveToStart={reorderable && menu && menuIndex > 0 ? () => void moveCard(menu.id, { beforeId: recordIds[0]! }) : undefined}
      />
    </ViewFrame>
  );
}

interface CardProps {
  record: TableRecord;
  primary: Field | undefined;
  fields: readonly Field[];
  coverField: Field | undefined;
  descriptionField: Field | undefined;
  crop: boolean;
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  color: string | undefined;
  sel: RecordSelection;
  nav: RovingItemProps;
  draggable: boolean;
  onOpen(): void;
  onMenu(anchor: MenuState["anchor"]): void;
}

function GalleryCard({ record: rec, primary, fields, coverField, descriptionField, crop, format, emails, color, sel, nav, draggable, onOpen, onMenu }: CardProps) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: rec.id, disabled: !draggable });
  // A right-click, the menu key, or a hold on a touch screen that lets go without moving (a hold that moves is the drag).
  const hold = useHoldMenu(onMenu);
  const title = cardTitle(primary, rec, format);
  const selected = sel.has(rec.id);
  const more = fieldsToShow(fields, rec, format, Infinity).length - GALLERY_FIELD_LIMIT;
  return (
    <div
      ref={setNodeRef}
      role="listitem"
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("group/card relative motion-reduce:transition-none!", isDragging && "z-20 opacity-90 [&>[role=button]]:shadow-pop")}
    >
      <div
        role="button"
        {...nav}
        {...listeners}
        // No aria-label: the card is named by what it draws, the title then its properties (WCAG 2.5.3).
        // Once something is selected a click selects, so the cards say which are.
        aria-pressed={sel.count > 0 ? selected : undefined}
        data-record-id={rec.id}
        data-selected={selected || undefined}
        onClick={(e) => {
          // A link inside the card goes where it points; a drag that ended on the card is not a click.
          if ((e.target as HTMLElement).closest("a")) return;
          if (!sel.handleClick(rec.id, e)) onOpen();
        }}
        {...hold}
        className={cn(
          "relative block w-full cursor-pointer overflow-hidden rounded-lg border bg-surface text-left transition-[border-color] hover:border-line-strong",
          selected ? "border-primary ring-2 ring-primary hover:border-primary" : "border-line",
          draggable && "select-none",
        )}
      >
        <CardBody
          record={rec}
          primary={primary}
          fields={fields}
          coverField={coverField}
          descriptionField={descriptionField}
          coverFit={crop ? "cover" : "contain"}
          coverHeight={132}
          layout="stacked"
          format={format}
          emails={emails}
          color={color}
          limit={GALLERY_FIELD_LIMIT}
          titleInset
        />
        {more > 0 && (
          <p data-more-fields className="-mt-2 px-4 pb-3 text-meta text-faint">
            +{more} more {more === 1 ? "field" : "fields"}
          </p>
        )}
      </div>
      {/* Beside the card, not in it: a control inside a button is not reachable by a screen reader. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Select ${title}`}
        tabIndex={-1}
        onClick={() => sel.toggle(rec.id)}
        // The button is the target (44 px on a touch screen, PH-6); the box inside it is what is drawn.
        className={cn(
          "absolute right-1 top-1 z-[2] flex size-8 items-center justify-center transition-opacity pointer-coarse:right-0 pointer-coarse:top-0 pointer-coarse:size-11",
          !selected && "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 pointer-coarse:opacity-100",
          sel.count > 0 && "opacity-100",
        )}
      >
        <span aria-hidden className={cn("flex size-6 items-center justify-center rounded-sm border bg-surface pointer-coarse:size-8", selected ? "border-primary bg-primary text-primary-fg" : "border-line-strong text-transparent")}>
          <Check aria-hidden className="size-4" strokeWidth={3} />
        </span>
      </button>
    </div>
  );
}
