/**
 * `/workspace/:workspaceId`: that workspace's Home (HOME-1 to HOME-11). A capture box, the person's Inbox drafts, what is due
 * soon and what changed recently. The two lists and the drafts come from one request (BE-3) and stay live through the
 * workspace's event stream (BE-9). The column is a container: the lists sit side by side from 760 px of column, whatever the
 * screen is (HOME-9).
 */
import { useMemo } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { WorkspaceSummary } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useWorkspaceEvents } from "@/hooks/useWorkspaceEvents";
import { topLevelOf } from "@/lib/topLevel";
import { atLeast } from "@/lib/roles";
import { useNavDialog } from "@/shell/NavDialogs";
import { HomeShell } from "@/shell/HomeShell";
import { useWorkspace } from "@/pages/workspace/useWorkspace";
import { CaptureBox } from "./CaptureBox";
import { DueSoon } from "./DueSoon";
import { InboxCard } from "./InboxCard";
import { RecentlyChanged } from "./RecentlyChanged";
import { browserTimeZone, headerDate } from "./capture";

export function HomePage() {
  const { workspaceId } = useParams();
  const { ws, fallback } = useWorkspace(workspaceId);
  return (
    <HomeShell workspaceId={workspaceId} variant="home">
      {ws ? <HomeContent ws={ws} /> : fallback}
    </HomeShell>
  );
}

function HomeContent({ ws }: { ws: WorkspaceSummary }) {
  const me = useMe();
  const openDialog = useNavDialog();
  useWorkspaceEvents(ws.id);
  const home = useQuery({ queryKey: keys.home(ws.id), queryFn: () => api.workspaces.home(ws.id) });
  const timeZone = me.data?.timezone || browserTimeZone();
  // The header reads the clock once per visit: a Home left open overnight is refreshed by its next event or focus.
  const today = useMemo(() => headerDate(Date.now(), timeZone), [timeZone]);

  const collections = ws.bases.reduce((n, b) => n + b.tables.length, 0);
  const top = topLevelOf(ws);
  const canMake = !!top && atLeast(top.role, "creator");
  const data = home.data;

  return (
    <div className="@container mx-auto flex w-full max-w-home flex-col gap-6 px-gutter pb-24 pt-8 max-md:gap-5 max-md:pt-4">
      <header className="flex flex-col gap-0.5">
        <p className="text-label text-muted">{today}</p>
        <h1 className="text-home max-md:text-home-phone">Home</h1>
      </header>
      <CaptureBox workspace={ws} />
      <InboxCard drafts={data?.drafts ?? []} workspace={ws} />
      {collections === 0 ? (
        <EmptyState
          title="Make your first collection"
          description={canMake ? "A collection holds one kind of thing: tasks, people, meals. What you add here will list its dates and changes on this page." : "Nothing is here yet. Ask the owner of this workspace for a collection to work in."}
          action={
            canMake && top ? (
              <Button variant="primary" onClick={() => openDialog({ kind: "create-collection", baseId: top.id })}>
                Make your first collection
              </Button>
            ) : undefined
          }
        />
      ) : home.isError && !data ? (
        <Notice tone="error">Home's lists could not be loaded: {errorMessage(home.error)}</Notice>
      ) : (
        <div className="grid items-start gap-6 max-md:gap-5 @min-[47.5rem]:grid-cols-2">
          <DueSoon workspaceId={ws.id} home={data} />
          <RecentlyChanged workspaceId={ws.id} home={data} />
        </div>
      )}
    </div>
  );
}
