/**
 * Turns a notification into text and a link. The payload keys are the ones the server writes
 * (`assigned` in engine/write.rs, `mention` in comments): `base_id`, `table_id`, `record_id`,
 * `record_name`, `snippet`, `actor_name`, plus `base_name`, `message` and `token` for invites
 * and automations. Every key is optional and anything unexpected is ignored, so a payload the
 * client does not know yet still renders.
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

/** `/base/:base/:table?record=:record`, as far as the payload goes. */
export function notificationHref(p: Record<string, unknown>): string | null {
  const base = text(p, "base_id");
  if (!base) return null;
  const table = text(p, "table_id");
  const record = text(p, "record_id");
  const path = `/base/${encodeURIComponent(base)}${table ? `/${encodeURIComponent(table)}` : ""}`;
  return record ? `${path}?record=${encodeURIComponent(record)}` : path;
}

function kindOf(kind: string): NotificationKind {
  return kind === "mention" || kind === "assigned" || kind === "invite" || kind === "automation" ? kind : "other";
}

export function describeNotification(n: Notification): NotificationView {
  const p = payloadOf(n);
  const actor = text(p, "actor_name") ?? "Someone";
  const record = text(p, "record_name");
  const snippet = text(p, "snippet");
  const message = text(p, "message");
  const kind = kindOf(n.kind);
  const href = notificationHref(p);
  switch (kind) {
    case "mention":
      return { kind, title: `${actor} mentioned you${record ? ` in ${record}` : ""}`, detail: snippet ?? message, href };
    case "assigned":
      return { kind, title: `${actor} assigned you to ${record ?? "a record"}`, detail: snippet ?? text(p, "field_name") ?? message, href };
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
