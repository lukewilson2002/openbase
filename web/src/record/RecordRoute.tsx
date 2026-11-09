/**
 * `/base/:baseId/:tableId/r/:recordId` and `/base/:baseId/:tableId/:viewId/r/:recordId`: a record's page in the
 * app shell. This reads the address and says what the page needs: the collection, the view whose order previous
 * and next follow (the one in the address, else the last one used for the collection, else its default), the
 * people, and where Escape and the back link lead.
 */
import { useCallback, useEffect, useMemo } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { isApiError } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useMe } from "@/auth/useAuth";
import { useBaseSchema } from "@/base/useBaseSchema";
import { ErrorState } from "@/components/ErrorState";
import { PageSpinner } from "@/components/ui/spinner";
import { useBaseEvents } from "@/hooks/useBaseEvents";
import { lastViewOf } from "@/lib/lastPlace";
import { browserTimeZone } from "@/lib/format";
import { defaultViewOf, namedViews } from "@/lib/views";
import { rememberWorkspace } from "@/pages/workspace/lastWorkspace";
import { AppShell } from "@/shell/AppShell";
import { HomeShell } from "@/shell/HomeShell";
import { NavDialogsProvider } from "@/shell/NavDialogs";
import { recordLayoutView } from "@/views/grid/useViewConfig";
import { useRecordNavigation } from "./navigation";
import { RecordPage } from "./RecordPage";
import { useRecordOrder } from "./useRecordOrder";

export function RecordRoute() {
  const { baseId = "", tableId = "", viewId, recordId = "" } = useParams();
  const base = useBaseSchema(baseId);
  useBaseEvents(baseId);
  const me = useMe();
  const nav = useRecordNavigation();

  const schema = base.data;
  const table = schema?.tables.find((t) => t.id === tableId);
  // The view the page was opened from; previous and next follow its order.
  const view = useMemo(() => {
    if (!table) return undefined;
    return table.views.find((v) => v.id === viewId) ?? table.views.find((v) => v.id === lastViewOf(table.id)) ?? defaultViewOf(table) ?? namedViews(table)[0];
  }, [table, viewId]);

  const workspaceId = schema?.workspace_id;
  useEffect(() => {
    if (workspaceId) rememberWorkspace(workspaceId);
  }, [workspaceId]);

  const collaborators = useQuery({ queryKey: keys.baseCollaborators(baseId), queryFn: () => api.bases.collaborators(baseId), staleTime: 60_000, enabled: !!schema });
  const people = useMemo(() => collaborators.data ?? [], [collaborators.data]);
  const emails = useMemo(() => new Map(people.map((u) => [u.id, u.email] as const)), [people]);
  const timeZone = me.data?.timezone || browserTimeZone();

  const order = useRecordOrder({ table, view, recordId, timeZone, handed: nav.order });

  const collectionPath = `/base/${baseId}/${tableId}${view ? `/${view.id}` : ""}`;
  // The crumb leads to this record's own collection; Escape and the phone's back link to where the trail began,
  // which is another collection when this page was reached through a linked record.
  const originHref = nav.origin(collectionPath);
  const originTable = schema?.tables.find((t) => t.id === /^\/base\/[^/]+\/([^/?#]+)/.exec(originHref)?.[1]);
  const back = useMemo(() => ({ href: originHref, label: (originTable ?? table)?.name ?? "" }), [originHref, originTable, table]);
  const onNavigate = useCallback((id: string) => nav.open({ baseId, tableId, recordId: id, viewId: view?.id }, { replace: true, fallbackFrom: collectionPath }), [nav, baseId, tableId, view?.id, collectionPath]);
  const onClose = useCallback(() => nav.close(collectionPath), [nav, collectionPath]);
  const onOpenLinked = useCallback((linkedTableId: string, linkedId: string) => nav.open({ baseId, tableId: linkedTableId, recordId: linkedId }, { fallbackFrom: collectionPath }), [nav, baseId, collectionPath]);

  if (base.isPending) return <PageSpinner label="Loading record" />;
  if (!schema || !table) {
    const missing = base.isError ? isApiError(base.error) && (base.error.isNotFound || base.error.isForbidden) : true;
    // Inside the shell, so an old link to something deleted still has the sidebar, the workspace switcher and the search.
    return (
      <HomeShell title={table ? undefined : "Record"} workspaceId={workspaceId}>
        {base.isError && !missing ? (
          <ErrorState title="Could not load this record" happened={base.error instanceof Error ? base.error.message : "Something went wrong while loading it."} todo="Reload the page in a moment, or go to Home." className="py-20" />
        ) : (
          <ErrorState title="Record not found" happened="It was deleted, or you do not have access to it." todo="Ask whoever sent the link, or go to Home and look from there." className="py-20" />
        )}
      </HomeShell>
    );
  }

  return (
    <NavDialogsProvider>
      <AppShell fill workspaceId={schema.workspace_id} tableId={table.id} mainLabel="Record" searchHere={{ workspaceId: schema.workspace_id, baseId: schema.id }}>
        <RecordPage
          schema={schema}
          table={table}
          role={schema.role}
          recordId={recordId}
          layoutView={recordLayoutView(table)}
          prevId={order.prevId}
          nextId={order.nextId}
          onNavigate={onNavigate}
          onClose={onClose}
          collectionHref={collectionPath}
          back={back}
          onOpenLinked={onOpenLinked}
          emails={emails}
          timeZone={timeZone}
          currentUserId={me.data?.id ?? null}
          collaborators={people}
        />
      </AppShell>
    </NavDialogsProvider>
  );
}
