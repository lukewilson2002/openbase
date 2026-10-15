/**
 * TanStack Query keys. Prefix conventions matter because SSE events invalidate by prefix:
 *   ["base", baseId]        base schema (tables, fields, views, caller role)
 *   ["records", tableId, …] anything that shows records of a table (view queries,
 *                           aggregations, single records, link pickers). Later
 *                           workstreams must put their record queries under this prefix.
 *   ["comments", recordId]  comment threads
 */
import type { TrashFilter } from "./endpoints";

export const keys = {
  setup: ["setup"] as const,
  me: ["me"] as const,
  sessions: ["sessions"] as const,
  /** The caller's passkeys. */
  passkeys: ["passkeys"] as const,
  tokens: ["tokens"] as const,
  /** The caller's connected apps (OAuth grants). */
  oauthGrants: ["oauth", "grants"] as const,
  /** A pending OAuth authorization request (consent page). */
  oauthRequest: (id: string) => ["oauth", "request", id] as const,
  workspaces: ["workspaces"] as const,
  /** The caller's deleted workspaces (home page, "Recently deleted workspaces"). */
  deletedWorkspaces: ["workspaces", "deleted"] as const,
  /** Prefix of every one-Trash listing: invalidate it after deleting or restoring anything. */
  trash: ["trash"] as const,
  /** `GET /api/trash` with these filters (`api.trash.all`). */
  trashListing: (filter: TrashFilter = {}) =>
    ["trash", filter.workspace_id ?? "", filter.base_id ?? "", filter.kind ?? ""] as const,
  workspaceMembers: (id: string) => ["workspace", id, "members"] as const,
  workspaceInvites: (id: string) => ["workspace", id, "invites"] as const,
  /** Prefix of every base's queries: who can open a base shows on all of them. */
  allBases: ["base"] as const,
  base: (id: string) => ["base", id] as const,
  baseMembers: (id: string) => ["base", id, "members"] as const,
  baseInvites: (id: string) => ["base", id, "invites"] as const,
  baseCollaborators: (id: string) => ["base", id, "collaborators"] as const,
  records: (tableId: string) => ["records", tableId] as const,
  comments: (recordId: string) => ["comments", recordId] as const,
  invitePreview: (token: string) => ["invite", token] as const,
  adminUsers: ["admin", "users"] as const,
  /** `before` is the audit-log cursor (an entry id), null for the newest page. */
  adminAudit: (before: number | null) => ["admin", "audit", before] as const,
  adminStats: ["admin", "stats"] as const,
  adminOauthGrants: ["admin", "oauth-grants"] as const,
  adminBackups: ["admin", "backups"] as const,
  adminEmail: ["admin", "email"] as const,
  notifications: ["notifications"] as const,
  /** "Search everything" results for `q` (`api.search.everything`). */
  search: (q: string, limit?: number) => ["search", q, limit ?? null] as const,
  /** Share links of one view (Creators). */
  shares: (viewId: string) => ["shares", viewId] as const,
  /** Automations of a base, and (under the same prefix) each one's run pages. */
  automations: (baseId: string) => ["automations", baseId] as const,
  automationRuns: (automationId: string) => ["automation-runs", automationId] as const,
  /** Last run of each automation, for the list's status column. */
  automationLastRun: (automationId: string) => ["automation-runs", automationId, "last"] as const,
};
