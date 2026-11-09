/**
 * The bar on top of a record page on a desktop (REC-1): 52 px, with the sidebar's toggle and the breadcrumb
 * (folder, collection, record, each but the record a link back) on the left, and on the right the save status, previous
 * and next record, who is viewing, Comments (with its count), History, Share and More. A phone has the 56 px
 * `PhoneHeader` instead, which the page draws itself.
 */
import { Link } from "react-router";
import { Check, ChevronDown, ChevronRight, ChevronUp, CopyPlus, Ellipsis, History, Link2, MessageSquare, Share2, Trash2 } from "lucide-react";
import type { BaseSchema, Table } from "@/api/types";
import { ColorMark } from "@/components/ui/color-mark";
import { CountBadge } from "@/components/ui/count-badge";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { usePresence } from "@/hooks/usePresence";
import { cn } from "@/lib/cn";
import { BaseAvatars } from "@/shell/BaseAvatars";
import { MenuItem, ActionMenu, MenuSeparator } from "@/shell/menuItems";
import { MenuToggle } from "@/shell/ScreenHeader";
import type { SaveState } from "./useRecordSave";

/** The record's save status. A polite live region, present from the start so changes are announced (A11Y-4). */
export function SaveStatus({ state }: { state: SaveState }) {
  return (
    <span role="status" aria-label="Save status" aria-live="polite" className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap px-1 text-meta", state === "error" ? "text-danger" : "text-muted")}>
      {state === "saving" && "Saving…"}
      {state === "saved" && (
        <span className="ob-fade-in flex items-center gap-1">
          <Icon icon={Check} size="sm" className="text-success" /> Saved
        </span>
      )}
      {state === "error" && "Couldn't save"}
    </span>
  );
}

export type RecordPanelKind = "comments" | "history";

export interface RecordActions {
  canEdit: boolean;
  duplicate(): void;
  copyLink(): void;
  remove(): void;
}

/** Comments with its count, as the button's name carries it. "Comments, 3" and not "Comments, 3": the drawn 3 must be a word of the name (WCAG 2.5.3). */
export function commentsLabel(count: number): string {
  return count > 0 ? `Comments, ${count}` : "Comments";
}

/** The items of More, written once for the dropdown and the phone's sheet. */
export function RecordMoreItems({ actions }: { actions: RecordActions }) {
  return (
    <>
      <MenuItem icon={CopyPlus} disabled={!actions.canEdit} onSelect={actions.duplicate}>
        Duplicate record
      </MenuItem>
      <MenuItem icon={Link2} onSelect={actions.copyLink}>
        Copy link
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={Trash2} danger disabled={!actions.canEdit} onSelect={actions.remove}>
        Delete record
      </MenuItem>
    </>
  );
}

export interface RecordBarProps {
  schema: BaseSchema;
  table: Table;
  /** The record's name, the last crumb. */
  title: string;
  /** The collection screen the page was opened from. */
  collectionHref: string;
  saveState: SaveState;
  prevId: string | null;
  nextId: string | null;
  onNavigate(recordId: string): void;
  panel: RecordPanelKind | null;
  panelId: string;
  onPanel(panel: RecordPanelKind): void;
  commentCount: number;
  onShare(): void;
  actions: RecordActions;
}

export function RecordBar({ schema, table, title, collectionHref, saveState, prevId, nextId, onNavigate, panel, panelId, onPanel, commentCount, onShare, actions }: RecordBarProps) {
  const viewers = usePresence(schema.id);
  const inFolder = !schema.is_top_level;
  const crumb = "flex min-h-6 min-w-0 items-center gap-1.5 rounded-sm px-1 text-ui text-muted no-underline hover:text-fg";
  return (
    <header className="flex h-13 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 pt-[env(safe-area-inset-top)] md:px-4">
      <MenuToggle />
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1">
          {inFolder && (
            <li className="flex min-w-0 shrink-[2] items-center gap-1">
              <Link to={`/base/${schema.id}`} className={crumb}>
                <ColorMark hue={schema.color} name={schema.name} size={8} />
                <span className="truncate">{schema.name}</span>
              </Link>
              <Icon icon={ChevronRight} size="sm" className="text-faint" />
            </li>
          )}
          <li className="flex min-w-0 shrink-[2] items-center gap-1">
            <Link to={collectionHref} className={crumb}>
              <ColorMark hue={table.color} name={table.name} size={8} />
              <span className="truncate">{table.name}</span>
            </Link>
            <Icon icon={ChevronRight} size="sm" className="text-faint" />
          </li>
          <li aria-current="page" className="min-w-0 truncate px-1 text-ui font-semibold">
            {title}
          </li>
        </ol>
      </nav>
      <SaveStatus state={saveState} />
      <div className="flex shrink-0 items-center">
        <IconButton label="Previous record (Alt+Up)" aria-keyshortcuts="Alt+ArrowUp" disabled={!prevId} onClick={() => prevId && onNavigate(prevId)}>
          <Icon icon={ChevronUp} />
        </IconButton>
        <IconButton label="Next record (Alt+Down)" aria-keyshortcuts="Alt+ArrowDown" disabled={!nextId} onClick={() => nextId && onNavigate(nextId)}>
          <Icon icon={ChevronDown} />
        </IconButton>
      </div>
      <Link to={`/workspace/${schema.workspace_id}/members`} className="inline-flex min-h-6 shrink-0 items-center rounded-pill px-1 no-underline">
        <span className="sr-only">Members: </span>
        <BaseAvatars people={schema.people} viewers={viewers} max={3} size="sm" />
      </Link>
      <div className="flex shrink-0 items-center">
        <IconButton label={commentsLabel(commentCount)} aria-expanded={panel === "comments"} aria-controls={panelId} onClick={() => onPanel("comments")} className={cn("relative", panel === "comments" && "bg-primary-soft text-primary-ink")}>
          <Icon icon={MessageSquare} />
          <CountBadge count={commentCount} />
        </IconButton>
        <IconButton label="History" aria-expanded={panel === "history"} aria-controls={panelId} onClick={() => onPanel("history")} className={cn(panel === "history" && "bg-primary-soft text-primary-ink")}>
          <Icon icon={History} />
        </IconButton>
        <IconButton label="Share" onClick={onShare}>
          <Icon icon={Share2} />
        </IconButton>
        <ActionMenu
          title="Record"
          trigger={
            <IconButton label="More" noTooltip>
              <Icon icon={Ellipsis} />
            </IconButton>
          }
        >
          <RecordMoreItems actions={actions} />
        </ActionMenu>
      </div>
    </header>
  );
}
