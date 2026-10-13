/**
 * TanStack Query keys. Prefix conventions matter because SSE events invalidate by prefix:
 *   ["base", baseId]        base schema (tables, fields, views, caller role)
 *   ["records", tableId, …] anything that shows records of a table (view queries,
 *                           aggregations, single records, link pickers). Later
 *                           workstreams must put their record queries under this prefix.
 *   ["comments", recordId]  comment threads
 */
export const keys = {
  setup: ["setup"] as const,
  me: ["me"] as const,
  sessions: ["sessions"] as const,
  tokens: ["tokens"] as const,
  workspaces: ["workspaces"] as const,
  workspaceMembers: (id: string) => ["workspace", id, "members"] as const,
  workspaceInvites: (id: string) => ["workspace", id, "invites"] as const,
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
  adminBackups: ["admin", "backups"] as const,
  notifications: ["notifications"] as const,
};
