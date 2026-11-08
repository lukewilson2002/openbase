import { Suspense, lazy, useEffect, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { FileQuestionMark, Table2 } from "lucide-react";
import { isApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageSpinner } from "@/components/ui/spinner";
import { useBaseEvents } from "@/hooks/useBaseEvents";
import { lastTableOf, lastViewOf, rememberPlace } from "@/lib/lastPlace";
import { legacyRecordTarget } from "@/lib/recordPath";
import { defaultViewOf, namedViews } from "@/lib/views";
import { rememberWorkspace } from "@/pages/workspace/lastWorkspace";
import { AppShell } from "@/shell/AppShell";
import { HomeShell } from "@/shell/HomeShell";
import { NavDialogsProvider } from "@/shell/NavDialogs";
import { AddRecordProvider } from "@/views/common/addRecord";
import { ViewHost } from "@/views/ViewHost";
import { BaseDialogContext, BaseDialogs, type BaseDialog } from "./BaseDialogs";
import { CollectionHeader } from "./CollectionHeader";
import { CollectionTabs, VIEW_PANEL_ID, viewTabId } from "./CollectionTabs";
import { EmptyBase } from "./EmptyBase";
import { basePermissions } from "./permissions";
import { useBaseSchema } from "./useBaseSchema";

// Rarely opened, and it pulls in the filter builder and the record editors: its own chunk.
const AutomationsPage = lazy(() => import("@/automations/AutomationsPage").then((m) => ({ default: m.AutomationsPage })));

/**
 * `/base/:baseId/:tableId?/:viewId?`: the app shell with the menu tree, the collection's header and
 * the active view as the page. Without a table (or a view) in the address it opens the one
 * last used on this device, else the first. With `section="automations"`
 * (`/base/:baseId/automations/...`) the page is the automations page instead.
 */
export function BaseShell({ section }: { section?: "automations" }) {
  const { baseId = "", tableId, viewId } = useParams();
  const location = useLocation();
  const [dialog, setDialog] = useState<BaseDialog | null>(null);
  const base = useBaseSchema(baseId);
  useBaseEvents(baseId);

  const loaded = base.data;
  const automations = section === "automations";
  // An address without a table or a view opens the one last used here, if it still exists.
  const table = !loaded || automations ? undefined : (loaded.tables.find((t) => t.id === tableId) ?? (tableId ? undefined : loaded.tables.find((t) => t.id === lastTableOf(loaded.id))) ?? loaded.tables[0]);
  // Else its first tab, the default view ("All clients"); a collection from before default views existed starts with its first saved view.
  const view = table?.views.find((v) => v.id === viewId) ?? (viewId ? undefined : (table?.views.find((v) => v.id === lastViewOf(table.id)) ?? (table ? (defaultViewOf(table) ?? namedViews(table)[0]) : undefined)));

  // What the menu's rows open next time: this view, its table, and the workspace used last.
  const workspaceId = loaded?.workspace_id;
  const tableOpen = table?.id;
  const viewOpen = view?.id;
  useEffect(() => {
    if (!workspaceId) return;
    rememberWorkspace(workspaceId);
    if (tableOpen && viewOpen) rememberPlace({ baseId, tableId: tableOpen, viewId: viewOpen });
  }, [workspaceId, baseId, tableOpen, viewOpen]);

  // Old links (emails, notifications, history) open a record with `?record=`; its page is where they lead now (decision 5).
  const legacy = automations || !tableId ? null : legacyRecordTarget(baseId, tableId, viewId, location.search);
  if (legacy) return <Navigate to={legacy} replace />;

  if (base.isPending) return <PageSpinner label="Loading folder" />;
  if (base.isError) {
    const missing = isApiError(base.error) && (base.error.isNotFound || base.error.isForbidden);
    // Inside the shell, so an old link to a deleted folder still has the sidebar, the workspace switcher and the search.
    return (
      <HomeShell title="Folder">
        <EmptyState
          icon={<FileQuestionMark />}
          title={missing ? "Folder not found" : "Could not load this folder"}
          description={missing ? "It may have been deleted, or you may not have access to it." : base.error instanceof Error ? base.error.message : undefined}
          action={
            <Button asChild variant="primary">
              <Link to="/">Go home</Link>
            </Button>
          }
          className="py-20"
        />
      </HomeShell>
    );
  }

  const schema = base.data;

  // Canonicalise the URL so deep links always carry table and view ids.
  if (table && view && (table.id !== tableId || view.id !== viewId)) {
    // Keep the query string.
    return <Navigate to={{ pathname: `/base/${schema.id}/${table.id}/${view.id}`, search: location.search }} replace />;
  }

  let page: React.ReactNode;
  if (automations) {
    page = (
      <div className="h-full overflow-auto">
        <Suspense fallback={<PageSpinner label="Loading automations" />}>
          <AutomationsPage schema={schema} />
        </Suspense>
      </div>
    );
  } else if (!table) {
    page = <EmptyBase schema={schema} />;
  } else if (!view) {
    page = (
      <EmptyState
        icon={<Table2 />}
        title="This collection has no views"
        description={basePermissions.createView(schema.role) ? "Change how its records are shown, then save it as a view." : "Ask an editor or creator to add a view."}
      />
    );
  } else {
    page = (
      <div className="h-full overflow-auto">
        <ViewHost schema={schema} table={table} view={view} />
      </div>
    );
  }

  return (
    <BaseDialogContext.Provider value={setDialog}>
      <NavDialogsProvider>
        <AddRecordProvider>
          <AppShell
            fill
            workspaceId={schema.workspace_id}
            tableId={table?.id}
            mainLabel={automations ? "Automations" : (view?.name ?? "Folder content")}
            searchHere={{ workspaceId: schema.workspace_id, baseId: schema.id }}
          >
            <CollectionHeader
              schema={schema}
              table={table}
              section={section}
              onShare={() => setDialog({ kind: "share", table: table ?? null, view: view ?? null, tab: "invite" })}
              onSettings={(t) => setDialog({ kind: "collection-settings", table: t })}
            />
            {table && view && <CollectionTabs schema={schema} table={table} view={view} />}
            <div className="relative min-h-0 flex-1" {...(table && view ? { id: VIEW_PANEL_ID, role: "tabpanel", "aria-labelledby": viewTabId(view.id) } : {})}>
              {page}
            </div>
            <BaseDialogs schema={schema} activeViewId={view?.id} dialog={dialog} onClose={() => setDialog(null)} />
          </AppShell>
        </AddRecordProvider>
      </NavDialogsProvider>
    </BaseDialogContext.Provider>
  );
}
