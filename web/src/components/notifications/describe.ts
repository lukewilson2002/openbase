/**
 * Turns a notification into text and a link. The payload keys are the ones the server writes:
 * `mention` (store/comments.rs) has `base_id`, `base_name`, `table_id`, `table_name`, `record_id`,
 * `record_name`, `comment_id`, `snippet`, `author_id`, `author_name` (and `base_icon`/`table_icon`,
 * the Lucide names the base and table had then, which `notificationPlace` returns); `assigned` (engine/write.rs)
 * has the same location keys plus `field_id`, `field_name` and `assigned_by` (a user id, no name);
 * `automation` has `message`, `automation_name`, `base_id`, `record_id`. Every key is optional
 * and anything unexpected is ignored, so a payload the client does not know yet still renders.
 */
import type { Notification } from "@/api/types";

export type NotificationKind = "mention" | "assigned" | "invite" | "automation" | "other";

export interface NotificationView {
  kind: NotificationKind;
  title: string;
  detail: string | null;
  /** In-app path to open, or null when the payload does not say where. */
  href: string | null;
}

function text(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function payloadOf(n: Notification): Record<string, unknown> {
  const p: unknown = n.payload;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

/**
 * `/base/:base/:table?record=:record`, as far as the payload goes. A record is only linked with
 * its table (the expanded record is looked up in the table of the route); automations name a
 * record but not its table, so they link to the base.
 */
export function notificationHref(p: Record<string, unknown>): string | null {
  const base = text(p, "base_id");
  if (!base) return null;
  const table = text(p, "table_id");
  const record = text(p, "record_id");
  const path = `/base/${encodeURIComponent(base)}${table ? `/${encodeURIComponent(table)}` : ""}`;
  return table && record ? `${path}?record=${encodeURIComponent(record)}` : path;
}

/** Who did it: the author of a mention (`actor_name` is accepted for invites and future kinds). */
function actorName(p: Record<string, unknown>): string {
  return text(p, "author_name") ?? text(p, "actor_name") ?? "Someone";
}

/** A base or table a notification is about, with the icon it had when the notification was written. */
export interface PlaceName {
  name: string;
  icon: string | null;
}

/** The base and table a notification names (`base_name`/`base_icon`, `table_name`/`table_icon`), if any. */
export function notificationPlace(n: Notification): { base: PlaceName | null; table: PlaceName | null } | null {
  const p = payloadOf(n);
  const one = (kind: "base" | "table"): PlaceName | null => {
    const name = text(p, `${kind}_name`);
    return name ? { name, icon: text(p, `${kind}_icon`) } : null;
  };
  const base = one("base");
  const table = one("table");
  return base || table ? { base, table } : null;
}

function kindOf(kind: string): NotificationKind {
  return kind === "mention" || kind === "assigned" || kind === "invite" || kind === "automation" ? kind : "other";
}

export function describeNotification(n: Notification): NotificationView {
  const p = payloadOf(n);
  const actor = actorName(p);
  const record = text(p, "record_name");
  const snippet = text(p, "snippet");
  const message = text(p, "message");
  const kind = kindOf(n.kind);
  const href = notificationHref(p);
  switch (kind) {
    case "mention":
      return { kind, title: `${actor} mentioned you${record ? ` in ${record}` : ""}`, detail: snippet ?? message, href };
    case "assigned": {
      // The server records who assigned (a user id) but not their name, so the title leaves them out.
      const field = text(p, "field_name");
      return { kind, title: `You were assigned to ${record ?? "a record"}`, detail: snippet ?? message ?? (field ? `In ${field}` : null), href };
    }
    case "invite": {
      const token = text(p, "token");
      return { kind, title: `${actor} invited you to ${text(p, "base_name") ?? text(p, "workspace_name") ?? "a base"}`, detail: message, href: token ? `/invite/${encodeURIComponent(token)}` : href };
    }
    case "automation":
      return { kind, title: text(p, "title") ?? (text(p, "automation_name") ? `Automation "${text(p, "automation_name")}"` : "Automation notification"), detail: message ?? snippet, href };
    default:
      return { kind, title: text(p, "title") ?? message ?? "New notification", detail: message && text(p, "title") ? message : snippet, href };
  }
}
