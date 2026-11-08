/**
 * The shell of the workspace-level screens (Home, a workspace's members, settings and automations,
 * account, admin, history, trash): the sidebar, and, inside `main`, the screen's own header (NAV-5).
 *
 * On a phone the header depends on where the screen sits (PH-2): Home carries the workspace switcher and the
 * avatar that opens the profile sheet (NAV-8), a tab's root screen (Collections, Notifications) has its title,
 * and every other screen has a back link naming the screen it came from.
 */
import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { Avatar } from "@/components/ui/avatar";
import { useMe } from "@/auth/useAuth";
import { workspaceToOpen } from "@/pages/workspace/lastWorkspace";
import { AppShell } from "./AppShell";
import { NavDialogsProvider } from "./NavDialogs";
import { PhoneBackLink, type PhoneAction } from "./PhoneHeader";
import { ProfileSheet } from "./ProfileSheet";
import { ScreenHeader } from "./ScreenHeader";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

export { useCreateWorkspace } from "./useCreateWorkspace";

export interface HomeShellProps {
  /** The workspace the page belongs to: it is open in the menu, and named in a phone's header. */
  workspaceId?: string;
  /** The screen's name, as the header's `h1`. Leave it out when the page's content starts with its own heading. */
  title?: ReactNode;
  /** The header's actions on a desktop, before the search. */
  actions?: ReactNode;
  /**
   * Where the screen sits on a phone: `home` (the workspace switcher and the avatar), `tab` (the root of a tab or of
   * the app: just its title) or `page`, the default (a back link to the Collections tab, or to Home with no workspace).
   */
  variant?: "page" | "tab" | "home";
  children: ReactNode;
}

export function HomeShell({ workspaceId: pageWorkspace, title, actions, variant = "page", children }: HomeShellProps) {
  const { pathname, search } = useLocation();
  // History and Trash of one workspace are those pages filtered to it, and the sidebar then shows that workspace.
  const filteredTo = pathname === "/trash" || pathname === "/history" ? new URLSearchParams(search).get("workspace") : null;
  const workspaceId = pageWorkspace ?? filteredTo ?? undefined;
  return (
    <NavDialogsProvider>
      <AppShell workspaceId={workspaceId} searchHere={workspaceId ? { workspaceId } : undefined}>
        <HomeHeader workspaceId={workspaceId} title={title} actions={actions} variant={variant} />
        {children}
      </AppShell>
    </NavDialogsProvider>
  );
}

function HomeHeader({ workspaceId, title, actions, variant }: Pick<HomeShellProps, "workspaceId" | "title" | "actions"> & { variant: NonNullable<HomeShellProps["variant"]> }) {
  const [profileOpen, setProfileOpen] = useState(false);
  const { data: user } = useMe();
  // Not retried on mount, like the shell's own (see AppShell): this header sits under the screen that shows the list's error.
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list, retryOnMount: false });
  const list = workspaces.data ?? [];
  const ws = list.find((w) => w.id === workspaceId) ?? workspaceToOpen(list);

  const account: PhoneAction[] = user
    ? [{ id: "account", label: "Account menu", face: <Avatar name={user.name} email={user.email} size="sm" own />, onSelect: () => setProfileOpen(true) }]
    : [];
  const back = workspaceId ? { to: `/workspace/${workspaceId}/collections`, label: "Collections" } : { to: "/", label: "Home" };

  return (
    <>
      <ScreenHeader
        title={title}
        actions={actions}
        phone={{
          leading: variant === "home" ? <WorkspaceSwitcher workspaces={list} current={ws} compact /> : variant === "page" ? <PhoneBackLink {...back} /> : undefined,
          actions: variant === "home" ? account : [],
        }}
      />
      {variant === "home" && <ProfileSheet open={profileOpen} onOpenChange={setProfileOpen} />}
    </>
  );
}
