/**
 * The header of a collection screen, drawn inside `main` in place of the old global top bar (NAV-5):
 * where the screen is (the workspace, and the folder unless it is the top level), the collection's name
 * as the screen's `h1` with its color mark, who is viewing, and Share. Phase 4 rebuilds this as the
 * full collection header (COL-1); until then it carries what the top bar carried. Share is for creators
 * and owners: inviting and sharing a view both need that role, so below it the dialog would hold nothing to do.
 *
 * On a phone it is the 56 px header of PH-2: a back link to the Collections tab, the collection's name, and
 * Share and Members as icon buttons beside the search (the viewers' faces need more room than a phone has).
 */
import { Link } from "react-router";
import { Share2, Users } from "lucide-react";
import type { BaseSchema, Table } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ColorMark } from "@/components/ui/color-mark";
import { Icon } from "@/components/ui/icon";
import { usePresence } from "@/hooks/usePresence";
import { BaseAvatars } from "@/shell/BaseAvatars";
import { PhoneBackLink, type PhoneAction } from "@/shell/PhoneHeader";
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
  const canShare = basePermissions.manageSharing(schema.role);
  const viewers = usePresence(schema.id);
  const inFolder = !schema.is_top_level && (!!table || section === "automations");
  const path = [schema.workspace_name, ...(inFolder ? [schema.name] : [])].join(" / ");
  const name = section === "automations" ? "Automations" : (table?.name ?? schema.name);
  const markHue = section === "automations" || !table ? schema.color : table.color;
  const phoneActions: PhoneAction[] = [
    ...(canShare ? [{ id: "share", label: "Share", icon: Share2, onSelect: onShare }] : []),
    { id: "members", label: "Members", icon: Users, to: `/workspace/${schema.workspace_id}/members` },
  ];
  return (
    <ScreenHeader
      phone={{
        leading: <PhoneBackLink to={`/workspace/${schema.workspace_id}/collections`} label="Collections" />,
        title: (
          <span className="flex min-w-0 items-center gap-2">
            <ColorMark hue={markHue} name={name} size={24} className="shrink-0" />
            <span className="min-w-0 truncate">{name}</span>
          </span>
        ),
        actions: phoneActions,
      }}
      actions={
        <>
          <Link to={`/workspace/${schema.workspace_id}/members`} className="shrink-0 rounded-pill px-1 no-underline">
            <BaseAvatars people={schema.people} viewers={viewers} max={4} size="md" />
          </Link>
          {canShare && (
            <Button onClick={onShare}>
              <Icon icon={Share2} /> Share
            </Button>
          )}
        </>
      }
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <p className="truncate text-label text-muted">{path}</p>
        <span aria-hidden className="text-line-strong">
          /
        </span>
        <h1 className="flex min-w-0 items-center gap-2 text-h2">
          <ColorMark hue={markHue} name={name} size={28} className="shrink-0" />
          <span className="min-w-0 truncate">{name}</span>
        </h1>
      </div>
    </ScreenHeader>
  );
}
