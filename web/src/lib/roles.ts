/** Roles in ascending order of power (docs/plans §3 "Permissions"). */
export const ROLES = ["viewer", "commenter", "editor", "creator", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  viewer: "Viewer",
  commenter: "Commenter",
  editor: "Editor",
  creator: "Creator",
  owner: "Owner",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: "Can view records",
  commenter: "Can view and comment",
  editor: "Can edit records",
  creator: "Can edit records and configure tables, fields and views",
  owner: "Full control, including sharing and deletion",
};

export function isRole(value: string | null | undefined): value is Role {
  return !!value && (ROLES as readonly string[]).includes(value);
}

/** True when `role` is at least `min`. Unknown or missing roles have no access. */
export function atLeast(role: string | null | undefined, min: Role): boolean {
  if (!isRole(role)) return false;
  return ROLES.indexOf(role) >= ROLES.indexOf(min);
}

/** Roles that `role` may grant to others (never above its own). */
export function grantableRoles(role: string | null | undefined): Role[] {
  if (!isRole(role)) return [];
  return ROLES.filter((r) => ROLES.indexOf(r) <= ROLES.indexOf(role));
}
