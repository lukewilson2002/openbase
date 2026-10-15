/**
 * Layout shared by the non-grid views: the toolbar (hide/filter/sort/colour/search, plus
 * view-specific settings), the view body, an optional footer line, and the expanded record
 * opened by `?record=recXXX`.
 */
import { useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import { ExpandedRecord } from "@/components/record/ExpandedRecord";
import { EditorEnvProvider } from "@/components/record/editors/env";
import { ViewBar } from "@/components/viewbar/ViewBar";
import type { ViewSetup } from "./useViewSetup";

/**
 * A view's body: on a desktop a rounded card on the page's grey, under the toolbar; on a phone it
 * runs edge to edge, where a margin would cost a column of the grid.
 */
export const viewBodyClass = "relative min-h-0 flex-1 border-t border-line bg-surface md:mx-4 md:mt-4 md:overflow-hidden md:rounded-xl md:border";
/** The count line under a view ("4 items"): a bar on a phone, plain text under the card on a desktop. */
export const viewFooterClass = "flex min-h-9 shrink-0 flex-wrap items-center gap-3 border-t border-line bg-subtle px-3 py-1 text-[0.8125rem] text-muted md:border-t-0 md:bg-transparent md:px-5";

export interface ViewFrameProps {
  setup: ViewSetup;
  /** Record ids in display order, for the previous/next buttons of the expanded record. */
  recordIds?: readonly string[];
  features?: ComponentProps<typeof ViewBar>["features"];
  hideFieldsNoun?: string;
  /** View-specific toolbar controls. */
  toolbarExtra?: ReactNode;
  footer?: ReactNode;
  /** The toolbar's "Add" (see ViewBar); omit when the view has no single obvious way to add a record. */
  onAdd?: () => void;
  children: ReactNode;
}

export function ViewFrame({ setup, recordIds, features, hideFieldsNoun = "Hide fields", toolbarExtra, footer, onAdd, children }: ViewFrameProps) {
  const { schema, table, view, role, cfg, config } = setup;
  const searchInputRef = useRef<HTMLInputElement>(null);

  const neighbours = useMemo(() => {
    if (!setup.openRecordId || !recordIds) return { prev: null as string | null, next: null as string | null };
    const i = recordIds.indexOf(setup.openRecordId);
    if (i < 0) return { prev: null, next: null };
    return { prev: recordIds[i - 1] ?? null, next: recordIds[i + 1] ?? null };
  }, [setup.openRecordId, recordIds]);

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
          extra={toolbarExtra}
          onAdd={onAdd}
        />
        <div className={viewBodyClass}>{children}</div>
        {footer ? <div className={viewFooterClass}>{footer}</div> : <div aria-hidden className="max-md:hidden md:h-4" />}
      </div>
      {setup.openRecordId && (
        <ExpandedRecord
          schema={schema}
          table={table}
          view={view}
          role={role}
          recordId={setup.openRecordId}
          config={config}
          prevId={neighbours.prev}
          nextId={neighbours.next}
          onNavigate={setup.openRecord}
          onClose={() => setup.openRecord(null)}
          emails={setup.emails}
          timeZone={setup.timeZone}
          currentUserId={setup.currentUserId}
          collaborators={setup.people}
        />
      )}
    </EditorEnvProvider>
  );
}
