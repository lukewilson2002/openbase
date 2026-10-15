/**
 * Switching workspace from the top bar (a base's header, a phone's home header and the base
 * drawer): the person's workspaces, the open one checked, and "New workspace".
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { NameDialog } from "@/components/NameDialog";
import { WorkspaceTile } from "@/components/icons/EntityIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { useCreateWorkspace } from "./useCreateWorkspace";

/** Rows of the place menus: roomier than the default menu rows, finger-sized on touch screens. */
export const placeItemClass = "gap-2.5 rounded-lg px-2.5 py-2 text-[0.875rem] pointer-coarse:min-h-11";

export function WorkspacePicker({ currentId, trigger, align = "start", className }: { currentId: string; trigger: ReactNode; align?: "start" | "end"; className?: string }) {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const [creating, setCreating] = useState(false);
  const create = useCreateWorkspace();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} sideOffset={6} aria-label="Workspaces" aria-labelledby={undefined} className={cn("w-60 rounded-xl p-1.5", className)}>
          {(workspaces.data ?? []).map((ws) => {
            const on = ws.id === currentId;
            return (
              <DropdownMenuItem key={ws.id} asChild role="menuitemradio" aria-checked={on} className={cn(placeItemClass, on && "font-semibold")}>
                <Link to={`/workspace/${ws.id}`}>
                  <WorkspaceTile ws={ws} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                  {on && <Check aria-hidden className="size-4 shrink-0 text-primary" />}
                </Link>
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator className="mx-1 my-1.5" />
          <DropdownMenuItem onSelect={() => setCreating(true)} className={cn(placeItemClass, "text-muted")}>
            <Plus aria-hidden className="size-4" /> New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog open={creating} onOpenChange={setCreating} title="New workspace" submitLabel="Create workspace" withIcon onSubmit={(name, icon) => create.mutateAsync({ name, icon })} />
    </>
  );
}
