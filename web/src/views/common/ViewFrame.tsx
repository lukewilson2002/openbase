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

export interface ViewFrameProps {
  setup: ViewSetup;
  /** Record ids in display order, for the previous/next buttons of the expanded record. */
  recordIds?: readonly string[];
  features?: ComponentProps<typeof ViewBar>["features"];
  hideFieldsNoun?: string;
  /** View-specific toolbar controls. */
  toolbarExtra?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

export function ViewFrame({ setup, recordIds, features, hideFieldsNoun = "Hide fields", toolbarExtra, footer, children }: ViewFrameProps) {
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
          saving={cfg.saving}
          update={cfg.update}
          collaborators={setup.people}
          currentUserId={setup.currentUserId}
          search={setup.search}
          onSearchChange={setup.setSearch}
          searchOpen={setup.searchOpen}
          onSearchOpenChange={setup.setSearchOpen}
          searchInputRef={searchInputRef}
          canManageFields={false}
          features={{ shareView: true, ...features }}
          hideFieldsNoun={hideFieldsNoun}
          extra={toolbarExtra}
        />
        <div className="relative min-h-0 flex-1 border-t border-line bg-surface">{children}</div>
        {footer && <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-3 border-t border-line bg-subtle px-3 py-1 text-[0.8125rem] text-muted">{footer}</div>}
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
