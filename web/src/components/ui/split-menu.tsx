/**
 * A two-column menu: groups on the left (tables, workspaces), the chosen group's items on the right
 * (views, bases). Pointing at or focusing a group only previews its items; the page changes when an
 * item is picked. One Radix menu underneath, so arrows, typeahead, Escape and focus return work as in
 * every other menu, and the arrow keys walk the groups and then the items.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Check, ChevronRight } from "lucide-react";
import { DropdownMenu as M } from "radix-ui";
import { cn } from "@/lib/cn";

export interface SplitMenuGroup {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface SplitMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Where picking it goes. */
  to: string;
  current?: boolean;
  /** Small marks after the name (personal, locked). */
  after?: ReactNode;
}

export interface SplitMenuAction {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  /** Menu items of a submenu the action opens instead (the view types of "Add view"). */
  sub?: ReactNode;
}

function ActionItem({ action }: { action: SplitMenuAction }) {
  const content = (
    <>
      {action.icon && <span className="flex shrink-0 items-center [&>svg]:size-4">{action.icon}</span>}
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
    </>
  );
  if (!action.sub) {
    return (
      <M.Item onSelect={action.onSelect} className={cn(row, "text-muted")}>
        {content}
      </M.Item>
    );
  }
  return (
    <M.Sub>
      <M.SubTrigger className={cn(row, "text-muted data-[state=open]:bg-hover")}>
        {content}
        <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-60" />
      </M.SubTrigger>
      <M.Portal>
        <M.SubContent sideOffset={4} collisionPadding={8} className="ob-pop-in z-50 w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-pop">
          {action.sub}
        </M.SubContent>
      </M.Portal>
    </M.Sub>
  );
}

const row =
  "flex min-h-9 w-full cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 text-left text-[0.875rem] text-fg no-underline outline-none data-[highlighted]:bg-hover pointer-coarse:min-h-11";

export function SplitMenu({
  trigger,
  label,
  groupsHeading,
  groups,
  currentGroupId,
  groupAction,
  itemsHeading,
  itemsFor,
  itemsTop,
  itemAction,
  onOpenChange,
  className,
}: {
  trigger: ReactNode;
  /** Accessible name of the menu ("Pick a table, then a view"). */
  label: string;
  groupsHeading: string;
  groups: readonly SplitMenuGroup[];
  currentGroupId: string | undefined;
  /** An action under the groups ("New table"). */
  groupAction?: SplitMenuAction;
  itemsHeading: (group: SplitMenuGroup) => string;
  itemsFor: (groupId: string) => readonly SplitMenuItem[];
  /** A link above the items ("Workspace home"), for the previewed group. */
  itemsTop?: (group: SplitMenuGroup) => { label: string; icon?: ReactNode; to: string } | null;
  /** An action under the items ("Add view"), for the previewed group. */
  itemAction?: (group: SplitMenuGroup) => SplitMenuAction | null;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const group = groups.find((g) => g.id === (preview ?? currentGroupId)) ?? groups[0];
  const items = group ? itemsFor(group.id) : [];
  const top = group && itemsTop ? itemsTop(group) : null;
  const action = group && itemAction ? itemAction(group) : null;

  return (
    <M.Root
      onOpenChange={(open) => {
        // Each opening starts on the group that is open on the page.
        if (!open) setPreview(undefined);
        onOpenChange?.(open);
      }}
    >
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content
          aria-label={label}
          // Radix names a menu after its trigger; this one has a name of its own.
          aria-labelledby={undefined}
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "ob-pop-in z-50 grid max-h-[min(30rem,calc(100dvh-6rem))] w-[min(28.25rem,calc(100vw-1.25rem))] grid-cols-[minmax(0,11rem)_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-[0.875rem] shadow-pop sm:grid-cols-[12.25rem_minmax(0,1fr)]",
            className,
          )}
        >
          <M.Group aria-label={groupsHeading} className="flex min-h-0 flex-col gap-px overflow-y-auto border-r border-line bg-bg p-1.5">
            <M.Label className="px-2.5 pb-1 pt-2 text-[0.8125rem] font-semibold text-muted">{groupsHeading}</M.Label>
            {groups.map((g) => {
              const on = g.id === group?.id;
              return (
                <M.Item
                  key={g.id}
                  role="menuitemradio"
                  aria-checked={on}
                  onSelect={(e) => {
                    // Picking a group previews it; only an item on the right changes the page.
                    e.preventDefault();
                    setPreview(g.id);
                  }}
                  onPointerMove={() => setPreview(g.id)}
                  onFocus={() => setPreview(g.id)}
                  className={cn(row, on && "bg-primary-soft font-semibold text-primary-ink data-[highlighted]:bg-primary-soft")}
                >
                  {g.icon && <span className="flex shrink-0 items-center [&>svg]:size-4">{g.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{g.label}</span>
                  <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-60" />
                </M.Item>
              );
            })}
            {groupAction && (
              <>
                <div className="min-h-1.5 flex-1" />
                <M.Separator className="mx-1 mb-1 h-px bg-line" />
                <ActionItem action={groupAction} />
              </>
            )}
          </M.Group>
          <M.Group aria-label={group ? itemsHeading(group) : undefined} className="flex min-h-0 flex-col gap-px overflow-y-auto p-1.5">
            {group && <M.Label className="truncate px-2.5 pb-1 pt-2 text-[0.8125rem] font-semibold text-muted">{itemsHeading(group)}</M.Label>}
            {top && (
              <>
                <M.Item asChild className={row}>
                  <Link to={top.to}>
                    {top.icon && <span className="flex size-6 shrink-0 items-center justify-center text-muted [&>svg]:size-4">{top.icon}</span>}
                    <span className="min-w-0 flex-1 truncate">{top.label}</span>
                  </Link>
                </M.Item>
                <M.Separator className="m-1 h-px bg-line" />
              </>
            )}
            {items.map((it) => (
              <M.Item key={it.id} asChild role="menuitemradio" aria-checked={!!it.current} className={cn(row, it.current && "font-semibold")}>
                <Link to={it.to}>
                  {it.icon && <span className="flex shrink-0 items-center text-muted [&>svg]:size-4">{it.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.after}
                  {it.current && <Check aria-hidden className="size-4 shrink-0 text-primary" />}
                </Link>
              </M.Item>
            ))}
            {action && (
              <>
                <div className="min-h-1.5 flex-1" />
                <M.Separator className="mx-1 mb-1 h-px bg-line" />
                <ActionItem action={action} />
              </>
            )}
          </M.Group>
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
