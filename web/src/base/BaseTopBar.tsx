/**
 * The project's parts of the app's top bar. On a desktop: `Household / Chores / Tasks` as plain text
 * at the start, in place of the logo (the open table last, the only bold part, in the accent colour), then "Search everything", who is viewing the project and Share. On a phone: the open table's
 * icon with `Household / Chores` small over its name (without a table open, the project's tile and
 * name), which opens the menu like the toggle beside it, then the faces and a Share icon. Getting
 * to another workspace or project is the menu's job. Share is for creators and owners: inviting and
 * sharing a view both need that role, so below it the dialog would hold nothing to do.
 */
import { Link } from "react-router";
import { Share2 } from "lucide-react";
import type { BaseSchema, Table } from "@/api/types";
import { EntityTile } from "@/components/icons/EntityIcon";
import { TableIcon } from "@/components/icons/TableIcon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { usePresence } from "@/hooks/usePresence";
import { BaseAvatars } from "@/shell/BaseAvatars";
import { useOpenMenu } from "@/shell/AppShell";
import { SearchSlot } from "@/shell/SearchEverything";
import { basePermissions } from "./permissions";
import { CRUMB_OPEN, CRUMB_TEXT, TableCrumb } from "./TableCrumb";

/** `Household / Chores / Tasks`: the desktop top bar's start, in place of the logo. */
export function BaseBrand({ schema, table }: { schema: BaseSchema; table?: Table }) {
  return (
    <div className="-ml-1.5 flex min-w-0 items-center gap-2 px-2">
      <span className={cn("flex min-w-0 items-center", CRUMB_TEXT)}>
        <span className="min-w-0 truncate">{schema.workspace_name}</span>
      </span>
      <span aria-hidden className="shrink-0 text-lg text-line-strong">
        /
      </span>
      <h1 className={cn("flex min-w-0 items-center", CRUMB_TEXT, !table && CRUMB_OPEN)}>
        <span className="min-w-0 truncate">{schema.name}</span>
      </h1>
      {table && (
        <>
          <span aria-hidden className="shrink-0 text-lg text-line-strong">
            /
          </span>
          <TableCrumb table={table} />
        </>
      )}
    </div>
  );
}

/** The rest of the top bar: on a phone the project's title, then faces and Share. */
export function BaseTopBar({ schema, table, onShare, desktop }: { schema: BaseSchema; table?: Table; onShare: () => void; desktop: boolean }) {
  const canShare = basePermissions.manageSharing(schema.role);
  const viewers = usePresence(schema.id);
  return (
    <>
      {/* The search box takes what room the path leaves; with too little it is a button at the end. */}
      {desktop ? <SearchSlot /> : <PhoneBaseTitle schema={schema} table={table} />}
      {/* Below 360 px the faces would leave the name no room at all; Members in the menu lists them. */}
      <Link to={`/workspace/${schema.workspace_id}/members`} className="shrink-0 rounded-full px-1 no-underline max-[359px]:hidden">
        <BaseAvatars people={schema.people} viewers={viewers} max={desktop ? 4 : 3} size={desktop ? "md" : "sm"} />
      </Link>
      {canShare &&
        (desktop ? (
          <Button onClick={onShare} className="h-[38px] shrink-0 gap-2 rounded-[10px] px-3.5 text-[0.875rem] font-semibold">
            <Share2 aria-hidden className="size-4" /> Share
          </Button>
        ) : (
          <button type="button" onClick={onShare} aria-label="Share" className="inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-fg hover:bg-hover">
            <Share2 aria-hidden className="size-5" />
          </button>
        ))}
    </>
  );
}

/** The phone's title: the project's tile, the path small over the open table's name. A tap opens the menu. */
function PhoneBaseTitle({ schema, table }: { schema: BaseSchema; table?: Table }) {
  const openMenu = useOpenMenu();
  return (
    <h1 className="min-w-0 flex-1 text-[1.0625rem]">
      <button
        type="button"
        onClick={openMenu}
        aria-label={`${table ? `${table.name} in ${schema.name}` : schema.name} in ${schema.workspace_name}. Open the menu`}
        className="flex h-12 max-w-full items-center gap-2.5 rounded-[10px] pl-1 pr-2 text-left hover:bg-hover"
      >
        {/* The tile is what the big name is: the open table's icon, else the project's tile. */}
        {table ? (
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-hover text-fg">
            <TableIcon icon={table.icon} className="size-[1.125rem]" />
          </span>
        ) : (
          <EntityTile name={schema.name} icon={schema.icon} color={schema.color} size="md" />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-normal leading-tight text-muted">{table ? `${schema.workspace_name} / ${schema.name}` : schema.workspace_name}</span>
          <span className="truncate font-bold leading-tight">{table?.name ?? schema.name}</span>
        </span>
      </button>
    </h1>
  );
}
