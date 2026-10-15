import { Suspense, lazy, useState } from "react";
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
import { AppShell } from "@/shell/AppShell";
import { ViewHost } from "@/views/ViewHost";
import { BaseDialogs, type BaseDialog } from "./BaseDialogs";
import { BaseSidebar, BaseSidebarFooter } from "./BaseSidebar";
import { BaseTopBar } from "./BaseTopBar";
import { EmptyBase } from "./EmptyBase";
import { basePermissions } from "./permissions";

// Rarely opened, and it pulls in the filter builder and the record editors: its own chunk.
const AutomationsPage = lazy(() => import("@/automations/AutomationsPage").then((m) => ({ default: m.AutomationsPage })));

/**
 * `/base/:baseId/:tableId?/:viewId?`: the app shell with the base's top bar and menu (tables and
 * their views), and the active view as the page. With `section="automations"`
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
  useBaseEvents(baseId);

  if (base.isPending) return <PageSpinner label="Loading base" />;
  if (base.isError) {
    const missing = isApiError(base.error) && (base.error.isNotFound || base.error.isForbidden);
    return (
      <EmptyState
        icon={<FileQuestionMark />}
        title={missing ? "Base not found" : "Could not load this base"}
        description={missing ? "It may have been deleted, or you may not have access to it." : base.error instanceof Error ? base.error.message : undefined}
        action={
          <Button asChild variant="primary">
            <Link to="/">Back to all bases</Link>
          </Button>
        }
        className="min-h-dvh justify-center"
      />
    );
  }

  const schema = base.data;
  const automations = section === "automations";
  const table = automations ? undefined : (schema.tables.find((t) => t.id === tableId) ?? schema.tables[0]);
  const view = table?.views.find((v) => v.id === viewId) ?? table?.views[0];

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
    page = <EmptyBase schema={schema} onImport={() => setDialog({ kind: "create-table-csv" })} />;
  } else if (!view) {
    page = (
      <EmptyState
        icon={<Table2 />}
        title="This table has no views"
        description={basePermissions.createView(schema.role) ? "Create one with Add view in the menu." : "Ask an editor or creator to add a view."}
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
    <AppShell
      fill
      hidePhoneLogo
      mainLabel={automations ? "Automations" : (view?.name ?? "Base content")}
      topBar={<BaseTopBar schema={schema} onShare={() => setDialog({ kind: "share", table: table ?? null, view: view ?? null, tab: "invite" })} />}
      sidebar={<BaseSidebar schema={schema} activeTableId={table?.id} activeViewId={view?.id} onDialog={setDialog} />}
      sidebarFooter={<BaseSidebarFooter schema={schema} section={section} />}
    >
      {page}
      <BaseDialogs schema={schema} activeTableId={table?.id} activeViewId={view?.id} dialog={dialog} onClose={() => setDialog(null)} />
    </AppShell>
  );
}
