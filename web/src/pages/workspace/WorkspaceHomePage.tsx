/**
 * `/workspace/:workspaceId`: that workspace's Home. Until Home is rebuilt (HOME-1 to HOME-11) it shows
 * what the old home page did, the Inbox's capture box and drafts, inside the new shell.
 */
import { useParams } from "react-router";
import { InboxPage } from "@/pages/inbox/InboxPage";
import { HomeShell } from "@/shell/HomeShell";
import { useWorkspace } from "./useWorkspace";

export function WorkspaceHomePage() {
  const { workspaceId } = useParams();
  const { ws, fallback } = useWorkspace(workspaceId);
  return <HomeShell workspaceId={workspaceId} variant="home">{ws ? <InboxPage title="Home" /> : fallback}</HomeShell>;
}
