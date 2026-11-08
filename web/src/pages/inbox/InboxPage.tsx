/**
 * The Inbox, which is also what a workspace's Home shows until Home is rebuilt (HOME-1 to HOME-11 absorb it, and
 * `/inbox` goes). A calm column like an AI chat's home: a heading and one big box to put something in
 * (a thought, a file), which stays a draft until it is saved into a table. The person's drafts are
 * listed under the box.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { HomeShell } from "@/shell/HomeShell";
import { HelpTip } from "@/components/ui/help-tip";
import { Capture } from "./Capture";

/** `/inbox`: the page on its own, in the shell. */
export function InboxRoute() {
  return (
    <HomeShell>
      <InboxPage title="Inbox" />
    </HomeShell>
  );
}

export function InboxPage({ title }: { title: string }) {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  return (
    <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-6 px-4 pb-24 pt-8 sm:pt-14">
      <header className="flex items-center gap-1.5">
        <h1 className="text-[1.75rem] leading-tight tracking-[-0.015em]">{title}</h1>
        <HelpTip label="About the Inbox">Write something down or add files, and save it to a table when you know where it belongs.</HelpTip>
      </header>
      <Capture workspaces={workspaces.data ?? []} />
    </div>
  );
}
