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
import { ViewHost } from "@/views/ViewHost";
import { basePermissions } from "./permissions";
import { TableTabs } from "./TableTabs";
import { TopBar } from "./TopBar";
import { ViewSidebar } from "./ViewSidebar";

// Rarely opened, and it pulls in the filter builder and the record editors: its own chunk.
const AutomationsPage = lazy(() => import("@/automations/AutomationsPage").then((m) => ({ default: m.AutomationsPage })));

/**
 * `/base/:baseId/:tableId?/:viewId?`: top bar, table tabs, view sidebar and the active view.
 * With `section="automations"` (`/base/:baseId/automations/...`) the content area is the automations page instead.
 */
export function BaseShell({ section }: { section?: "automations" }) {
  const { baseId = "", tableId, viewId } = useParams();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
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

  if (section === "automations") {
    return (
      <div className="relative flex h-dvh flex-col">
        <TopBar schema={schema} />
        <TableTabs schema={schema} activeTableId={undefined} />
        <main className="min-w-0 flex-1 overflow-auto bg-bg" aria-label="Automations">
          <Suspense fallback={<PageSpinner label="Loading automations" />}>
            <AutomationsPage schema={schema} />
          </Suspense>
        </main>
      </div>
    );
  }

  const table = schema.tables.find((t) => t.id === tableId) ?? schema.tables[0];
  const view = table?.views.find((v) => v.id === viewId) ?? table?.views[0];

  // Canonicalise the URL so deep links always carry table and view ids.
  if (table && view && (table.id !== tableId || view.id !== viewId)) {
    // Keep the query string: notification links arrive as /base/:id/:table?record=rec.
    return <Navigate to={{ pathname: `/base/${schema.id}/${table.id}/${view.id}`, search: location.search }} replace />;
  }

  return (
    <div className="relative flex h-dvh flex-col">
      <TopBar schema={schema} />
      <TableTabs schema={schema} activeTableId={table?.id} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((o) => !o)} />
      <div className="relative flex min-h-0 flex-1">
        {table && <ViewSidebar schema={schema} table={table} activeViewId={view?.id} open={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />}
        {sidebarOpen && <button type="button" aria-label="Close views" className="absolute inset-0 z-30 bg-overlay md:hidden" onClick={() => setSidebarOpen(false)} />}
        <main className="min-w-0 flex-1 overflow-auto bg-bg" aria-label={view ? view.name : "Base content"}>
          {!table ? (
            <EmptyState
              icon={<Table2 />}
              title="This base has no tables"
              description={basePermissions.manageTables(schema.role) ? "Use the + button above to add your first table." : "Ask a creator to add a table."}
            />
          ) : !view ? (
            <EmptyState icon={<Table2 />} title="This table has no views" description={basePermissions.createView(schema.role) ? "Create one from the sidebar." : "Ask an editor or creator to add a view."} />
          ) : (
            <ViewHost schema={schema} table={table} view={view} />
          )}
        </main>
      </div>
    </div>
  );
}
