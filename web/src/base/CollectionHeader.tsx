/**
 * The header of a collection screen, drawn inside `main` in place of the old global top bar (NAV-5):
 * where the screen is (the workspace, and the folder unless it is the top level), the collection's name
 * as the screen's `h1` with its color mark, who is viewing, and Share. Phase 4 rebuilds this as the
 * full collection header (COL-1); until then it carries what the top bar carried. Share is for creators
 * and owners: inviting and sharing a view both need that role, so below it the dialog would hold nothing to do.
 */
import { Link } from "react-router";
import { Share2 } from "lucide-react";
import type { BaseSchema, Table } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ColorMark } from "@/components/ui/color-mark";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { usePresence } from "@/hooks/usePresence";
import { BaseAvatars } from "@/shell/BaseAvatars";
import { ScreenHeader } from "@/shell/ScreenHeader";
import { basePermissions } from "./permissions";

export interface CollectionHeaderProps {
  schema: BaseSchema;
  /** The open collection; without one the header names the folder. */
  table?: Table;
  /** `/base/:baseId/automations/...`: the folder's automations instead of a collection. */
  section?: "automations";
  onShare: () => void;
}

export function CollectionHeader({ schema, table, section, onShare }: CollectionHeaderProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const canShare = basePermissions.manageSharing(schema.role);
  const viewers = usePresence(schema.id);
  const inFolder = !schema.is_top_level && (!!table || section === "automations");
  const path = [schema.workspace_name, ...(inFolder ? [schema.name] : [])].join(" / ");
  const name = section === "automations" ? "Automations" : (table?.name ?? schema.name);
  const markHue = section === "automations" || !table ? schema.color : table.color;
  return (
    <ScreenHeader
      actions={
        <>
          {/* Below 360 px the faces would leave the name no room at all; Members in the menu lists them. */}
          <Link to={`/workspace/${schema.workspace_id}/members`} className="shrink-0 rounded-pill px-1 no-underline max-[359px]:hidden">
            <BaseAvatars people={schema.people} viewers={viewers} max={desktop ? 4 : 3} size={desktop ? "md" : "sm"} />
          </Link>
          {canShare &&
            (desktop ? (
              <Button onClick={onShare}>
                <Icon icon={Share2} /> Share
              </Button>
            ) : (
              <IconButton label="Share" onClick={onShare}>
                <Icon icon={Share2} />
              </IconButton>
            ))}
        </>
      }
    >
      <div className="flex min-w-0 flex-1 flex-col md:flex-row md:items-center md:gap-2">
        <p className="truncate text-meta text-muted md:text-label">{path}</p>
        <span aria-hidden className="hidden text-line-strong md:inline">
          /
        </span>
        <h1 className="flex min-w-0 items-center gap-2 text-h3 md:text-h2">
          <ColorMark hue={markHue} name={name} size={desktop ? 28 : 24} className="shrink-0" />
          <span className="min-w-0 truncate">{name}</span>
        </h1>
      </div>
    </ScreenHeader>
  );
}
