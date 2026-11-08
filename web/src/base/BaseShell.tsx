import { Suspense, lazy, useEffect, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { FileQuestionMark, Table2 } from "lucide-react";
import { isApiError } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageSpinner } from "@/components/ui/spinner";
import { useBaseEvents } from "@/hooks/useBaseEvents";
import { lastTableOf, lastViewOf, rememberPlace } from "@/lib/lastPlace";
import { defaultViewOf, namedViews } from "@/lib/views";
import { rememberWorkspace } from "@/pages/workspace/lastWorkspace";
import { AppShell } from "@/shell/AppShell";
import { NavDialogsProvider } from "@/shell/NavDialogs";
import { ViewHost } from "@/views/ViewHost";
import { BaseDialogContext, BaseDialogs, type BaseDialog } from "./BaseDialogs";
import { CollectionHeader } from "./CollectionHeader";
import { EmptyBase } from "./EmptyBase";
import { basePermissions } from "./permissions";

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
  const base = useQuery({
    queryKey: keys.base(baseId),
    queryFn: () => api.bases.get(baseId),
    retry: (count, err) => !(isApiError(err) && (err.status === 404 || err.status === 403)) && count < 2,
  });
  // The menu tree is built from the workspaces list: fetched beside the project, not after it.
  useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  useBaseEvents(baseId);

  const loaded = base.data;
  const automations = section === "automations";
  // An address without a table or a view opens the one last used here, if it still exists.
  const table = !loaded || automations ? undefined : (loaded.tables.find((t) => t.id === tableId) ?? (tableId ? undefined : loaded.tables.find((t) => t.id === lastTableOf(loaded.id))) ?? loaded.tables[0]);
  // Else its first view, else its default grid (a new table has no other).
  const view = table?.views.find((v) => v.id === viewId) ?? (viewId ? undefined : (table?.views.find((v) => v.id === lastViewOf(table.id)) ?? (table ? (namedViews(table)[0] ?? defaultViewOf(table)) : undefined)));

  // What the menu's rows open next time: this view, its table, its project.
  const workspaceId = loaded?.workspace_id;
  const tableOpen = table?.id;
  const viewOpen = view?.id;
  useEffect(() => {
    if (!workspaceId) return;
    rememberWorkspace(workspaceId);
    if (tableOpen && viewOpen) rememberPlace({ workspaceId, baseId, tableId: tableOpen, viewId: viewOpen });
  }, [workspaceId, baseId, tableOpen, viewOpen]);

  if (base.isPending) return <PageSpinner label="Loading project" />;
  if (base.isError) {
    const missing = isApiError(base.error) && (base.error.isNotFound || base.error.isForbidden);
    return (
      <EmptyState
        icon={<FileQuestionMark />}
        title={missing ? "Project not found" : "Could not load this project"}
        description={missing ? "It may have been deleted, or you may not have access to it." : base.error instanceof Error ? base.error.message : undefined}
        action={
          <Button asChild variant="primary">
            <Link to="/">Back to my projects</Link>
          </Button>
        }
        className="min-h-dvh justify-center"
      />
    );
  }

  const schema = base.data;

  // Canonicalise the URL so deep links always carry table and view ids.
  if (table && view && (table.id !== tableId || view.id !== viewId)) {
    // Keep the query string: notification links arrive as /base/:id/:table?record=rec.
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
        title="This table has no views"
        description={basePermissions.createView(schema.role) ? "Create one with the + beside the views." : "Ask an editor or creator to add a view."}
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
        <AppShell
          fill
          workspaceId={schema.workspace_id}
          tableId={table?.id}
          mainLabel={automations ? "Automations" : (view?.name ?? "Folder content")}
          searchHere={{ workspaceId: schema.workspace_id, baseId: schema.id }}
        >
          <CollectionHeader schema={schema} table={table} section={section} onShare={() => setDialog({ kind: "share", table: table ?? null, view: view ?? null, tab: "invite" })} />
          <div className="relative min-h-0 flex-1">{page}</div>
          <BaseDialogs schema={schema} activeViewId={view?.id} dialog={dialog} onClose={() => setDialog(null)} />
        </AppShell>
      </NavDialogsProvider>
    </BaseDialogContext.Provider>
  );
}
