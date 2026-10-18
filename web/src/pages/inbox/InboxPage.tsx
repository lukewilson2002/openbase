/**
 * `/`: the Inbox. A calm column like an AI chat's home: a heading and one big box to put something in
 * (a thought, a file), which stays a draft until it is saved into a table. The person's drafts are
 * listed under the box. The menu is the app's usual one (the page sits in `HomeShell`, see `HomePage`).
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { HelpTip } from "@/components/ui/help-tip";
import { Capture } from "./Capture";

export function InboxPage() {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  return (
    <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-6 px-4 pb-24 pt-8 sm:pt-14">
      <header className="flex items-center gap-1.5">
        <h1 className="text-[1.75rem] leading-tight tracking-[-0.015em]">Inbox</h1>
        <HelpTip label="About the Inbox">Write something down or add files, and save it to a table when you know where it belongs.</HelpTip>
      </header>
      <Capture workspaces={workspaces.data ?? []} />
    </div>
  );
}
