/**
 * The project's parts of the app's top bar. On a desktop: `[tile] Household / [tile] Chores /
 * [icon] Tasks` as plain text at the start, in place of the logo (the open table last, its icon a
 * button that changes it), then who can open the project and Share. On a phone: the project's tile
 * with `Household / Chores` small over the table's name (or the project's, without a table open),
 * which opens the menu like the toggle beside it, then the faces and a Share icon. Getting to another workspace or project is
 * the menu's job. Share is for creators and owners: inviting and sharing a view both need that role,
 * so below it the dialog would hold nothing to do.
 */
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table } from "@/api/types";
import { EntityTile, WorkspaceTile } from "@/components/icons/EntityIcon";
import { Button } from "@/components/ui/button";
import { BaseAvatars } from "@/shell/BaseAvatars";
import { useOpenMenu } from "@/shell/AppShell";
import { basePermissions } from "./permissions";
import { TableCrumb } from "./TableCrumb";

/** `Household / Chores / Tasks` with their icons: the desktop top bar's start, in place of the logo. */
export function BaseBrand({ schema, table }: { schema: BaseSchema; table?: Table }) {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  // The tile's colour comes from the workspaces list, which may not be here yet.
  const ws = workspaces.data?.find((w) => w.id === schema.workspace_id) ?? { name: schema.workspace_name };
  return (
    <div className="-ml-1.5 flex min-w-0 items-center gap-2 px-2">
      <span className="flex min-w-0 items-center gap-2 text-[0.875rem] font-medium text-muted">
        <WorkspaceTile ws={ws} size="xs" />
        <span className="min-w-0 truncate">{schema.workspace_name}</span>
      </span>
      <span aria-hidden className="shrink-0 text-lg text-line-strong">
        /
      </span>
      <h1 className="flex min-w-0 items-center gap-2 text-base font-bold">
        <EntityTile name={schema.name} icon={schema.icon} color={schema.color} size="md" className="size-7 rounded-[7px]" />
        <span className="min-w-0 truncate">{schema.name}</span>
      </h1>
      {table && (
        <>
          <span aria-hidden className="shrink-0 text-lg text-line-strong">
            /
          </span>
          <TableCrumb schema={schema} table={table} />
        </>
      )}
    </div>
  );
}

/** The rest of the top bar: on a phone the project's title, then faces and Share. */
export function BaseTopBar({ schema, table, onShare, desktop }: { schema: BaseSchema; table?: Table; onShare: () => void; desktop: boolean }) {
  const canShare = basePermissions.manageSharing(schema.role);
  return (
    <>
      {desktop ? <div className="flex-1" /> : <PhoneBaseTitle schema={schema} table={table} />}
      {/* Below 360 px the faces would leave the name no room at all; Members in the menu lists them. */}
      <Link to={`/workspace/${schema.workspace_id}/members`} className="shrink-0 rounded-full px-1 no-underline max-[359px]:hidden">
        <BaseAvatars people={schema.people} max={desktop ? 4 : 3} size={desktop ? "md" : "sm"} />
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
        <EntityTile name={schema.name} icon={schema.icon} color={schema.color} size="md" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-normal leading-tight text-muted">{table ? `${schema.workspace_name} / ${schema.name}` : schema.workspace_name}</span>
          <span className="truncate font-bold leading-tight">{table?.name ?? schema.name}</span>
        </span>
      </button>
    </h1>
  );
}
