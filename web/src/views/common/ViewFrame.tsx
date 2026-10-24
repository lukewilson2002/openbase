/**
 * Layout shared by the non-grid views: the toolbar (hide/filter/sort/colour/search, plus
 * view-specific settings), the view body, an optional footer line, and the expanded record
 * opened by `?record=recXXX`.
 */
import { useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import { RecordPanel } from "./RecordPanel";
import { EditorEnvProvider } from "@/components/record/editors/env";
import { ViewBar, type MoreToggle } from "@/components/viewbar/ViewBar";
import { cn } from "@/lib/cn";
import { gridRecordLayout } from "@/views/grid/useViewConfig";
import { useUndoShortcuts } from "./useUndoShortcuts";
import type { ViewSetup } from "./useViewSetup";

/**
 * A view's body: on a desktop a rounded card on the page's grey, under the toolbar; on a phone it
 * runs edge to edge, where a margin would cost a column of the grid.
 */
export const viewBodyClass = "relative min-h-0 flex-1 border-t border-line bg-surface md:mx-4 md:mt-4 md:overflow-hidden md:rounded-xl md:border";
/**
 * The count line under a view ("4 items"): a bar on a phone, plain text under the card on a desktop.
 * On a phone the bar is the bottom of the screen: it stays above the home indicator and clear of the
 * rounded corners, and its right end is left to the floating "Add" button.
 */
export const viewFooterClass =
  "flex min-h-9 shrink-0 flex-wrap items-center gap-3 border-t border-line bg-subtle px-3 py-1 text-[0.8125rem] text-muted max-md:pb-[max(0.25rem,env(safe-area-inset-bottom))] max-md:pl-5 max-md:pr-36 md:border-t-0 md:bg-transparent md:px-5";

/**
 * A list or grid edge to edge under the toolbar, with no frame around it, as tall as its content (a
 * short one ends where its rows end, with the count right under it), shrinking to the space left and
 * scrolling inside once it is longer. On a phone it fills the screen like `viewBodyClass`, with the
 * count as a bar at the bottom.
 */
export const viewHugAreaClass = "flex min-h-0 flex-1 flex-col";
// On a desktop the toolbar's own bottom line is the top edge.
export const viewHugCardClass = "relative flex min-h-0 flex-col border-t border-line bg-surface max-md:flex-1 md:overflow-hidden md:border-t-0 md:border-b";
export const viewHugFooterClass = cn(viewFooterClass, "md:min-h-0 md:px-4 md:py-2");

export type ViewLayout = "fill" | "hug" | "bare";

export interface ViewFrameProps {
  setup: ViewSetup;
  /** Record ids in display order, for the previous/next buttons of the expanded record. */
  recordIds?: readonly string[];
  features?: ComponentProps<typeof ViewBar>["features"];
  hideFieldsNoun?: string;
  /** The view type's main setting, first in the toolbar (see ViewBar `setting`). */
  toolbarSetting?: ReactNode;
  /** View-specific toolbar controls after the tools. */
  toolbarExtra?: ReactNode;
  moreToggles?: readonly MoreToggle[];
  footer?: ReactNode;
  /**
   * How the body sits on the page: `fill` is a card as tall as the page (calendar), `hug` a card as
   * tall as its content (list, timeline), `bare` straight on the page's grey for views that draw
   * their own cards (kanban stacks, gallery cards, the "choose a field" states).
   */
  layout?: ViewLayout;
  /** The toolbar's "Add" (see ViewBar); omit when the view has no single obvious way to add a record. */
  onAdd?: () => void;
  children: ReactNode;
}

export function ViewFrame({ setup, recordIds, features, hideFieldsNoun = "Hide fields", toolbarSetting, toolbarExtra, moreToggles, footer, layout = "fill", onAdd, children }: ViewFrameProps) {
  const { schema, table, view, role, cfg, config } = setup;
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Ctrl/Cmd+Z reverts the last drop, edit, add or delete (not while a record is open: its fields have their own).
  useUndoShortcuts(setup.writes.history, setup.canEdit && !setup.openRecordId);
  // A record shows its fields as the table's grid lays them out, whichever view it is opened from.
  const recordLayout = useMemo(() => gridRecordLayout(table, role) ?? config, [table, role, config]);

  const neighbours = useMemo(() => {
    if (!setup.openRecordId || !recordIds) return { prev: null as string | null, next: null as string | null };
    const i = recordIds.indexOf(setup.openRecordId);
    if (i < 0) return { prev: null, next: null };
    return { prev: recordIds[i - 1] ?? null, next: recordIds[i + 1] ?? null };
  }, [setup.openRecordId, recordIds]);

  let body: ReactNode;
  if (layout === "hug") {
    body = (
      <div className={viewHugAreaClass}>
        <div className={viewHugCardClass}>{children}</div>
        {footer && <div className={viewHugFooterClass}>{footer}</div>}
      </div>
    );
  } else if (layout === "bare") {
    body = (
      <div className="relative min-h-0 flex-1 overflow-auto">
        {children}
        {footer && <div className="flex flex-wrap items-center gap-3 px-4 pb-4 text-[0.8125rem] text-muted md:px-5 max-md:pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    );
  } else {
    body = (
      <>
        <div className={viewBodyClass}>{children}</div>
        {footer ? <div className={viewFooterClass}>{footer}</div> : <div aria-hidden className="h-[env(safe-area-inset-bottom)] shrink-0 md:h-4" />}
      </>
    );
  }

  return (
    <EditorEnvProvider value={setup.editorEnv}>
      <div className="flex h-full min-h-[24rem] flex-col">
        <ViewBar
          schema={schema}
          table={table}
          view={view}
          role={role}
          config={config}
          canConfigure={cfg.canConfigure}
          hasLocalQuery={cfg.transient !== null}
          onResetLocalQuery={cfg.resetTransient}
          saving={cfg.saving}
          update={cfg.update}
          collaborators={setup.people}
          currentUserId={setup.currentUserId}
          search={setup.search}
          onSearchChange={setup.setSearch}
          searchOpen={setup.searchOpen}
          onSearchOpenChange={setup.setSearchOpen}
          searchInputRef={searchInputRef}
          timeZone={setup.timeZone}
          features={features}
          hideFieldsNoun={hideFieldsNoun}
          setting={toolbarSetting}
          extra={toolbarExtra}
          moreToggles={moreToggles}
          onAdd={onAdd}
        />
        {body}
      </div>
      {setup.openRecordId && (
        <RecordPanel
          schema={schema}
          table={table}
          view={view}
          role={role}
          recordId={setup.openRecordId}
          config={recordLayout}
          prevId={neighbours.prev}
          nextId={neighbours.next}
          onNavigate={setup.openRecord}
          onClose={() => setup.openRecord(null)}
          justCreated={setup.newRecordId === setup.openRecordId}
          // Deletes and copies go through the view's writes, so they can be undone.
          onDeleteRecord={setup.canEdit ? (id) => setup.writes.remove([id]) : undefined}
          onDuplicateRecord={setup.canEdit ? async (r) => (await setup.writes.duplicate([r]))[0] : undefined}
          emails={setup.emails}
          timeZone={setup.timeZone}
          currentUserId={setup.currentUserId}
          collaborators={setup.people}
        />
      )}
      {setup.actions.dialog}
    </EditorEnvProvider>
  );
}
