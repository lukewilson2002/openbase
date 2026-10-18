import type { TrashItem } from "@/api/types";
import type { TrashKind } from "@/api/endpoints";
import { relativeTime } from "@/lib/relativeTime";

/** Days the server keeps deleted items unless the administrator changed `OPENBASE_TRASH_DAYS`. */
export const DEFAULT_RETENTION_DAYS = 30;

const DAY = 24 * 3600_000;

export const TRASH_KIND_LABELS: Record<TrashKind, string> = {
  record: "Record",
  field: "Field",
  table: "Table",
  view: "View",
  base: "Project",
  workspace: "Workspace",
};

export function trashKindLabel(kind: string): string {
  return TRASH_KIND_LABELS[kind as TrashKind] ?? kind;
}

/** What to call an item: records and views can be unnamed. */
export function trashItemName(item: TrashItem): string {
  const name = item.name.trim();
  if (name) return name;
  return item.kind === "record" ? "Untitled record" : `Unnamed ${item.kind}`;
}

/** Where it was: "Household › Chores › Chores" (workspace, base, then table for what lives in one). */
export function trashItemPlace(item: TrashItem): string {
  if (item.kind === "workspace") return "Your workspaces";
  const parts = [item.workspace_name];
  if (item.kind !== "base" && item.base_name) parts.push(item.base_name);
  if (item.table_name) parts.push(item.table_name);
  return parts.join(" › ");
}

/** "Deleted by Alex, 2 hours ago"; "you" for the caller, and no name when nobody was recorded. */
export function trashItemDeleted(item: TrashItem, meId: string | undefined, now = Date.now()): string {
  const when = relativeTime(item.deleted_at, now);
  if (item.deleted_by_id && item.deleted_by_id === meId) return `Deleted by you, ${when}`;
  if (item.deleted_by_name) return `Deleted by ${item.deleted_by_name}, ${when}`;
  return `Deleted ${when}`;
}

/** "30 days left" until the purge removes it; on its last day, "Removed today". */
export function trashDaysLeft(item: TrashItem, now = Date.now()): string {
  const days = Math.max(0, Math.ceil((item.expires_at - now) / DAY));
  if (days === 0) return "Removed today";
  return days === 1 ? "1 day left" : `${days} days left`;
}

/**
 * How long the server keeps things, read off the items (each one's `expires_at` is its
 * `deleted_at` plus the server's retention), since the server does not publish the setting.
 */
export function retentionDays(items: readonly TrashItem[]): number {
  const item = items[0];
  if (!item) return DEFAULT_RETENTION_DAYS;
  return Math.max(1, Math.round((item.expires_at - item.deleted_at) / DAY));
}
