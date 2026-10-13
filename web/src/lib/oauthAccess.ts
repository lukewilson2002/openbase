/** The access levels an OAuth app can be given, lowest first (they mirror the server's `Access`). */
export type OAuthAccess = "read" | "write" | "manage";

export const ACCESS_ORDER: OAuthAccess[] = ["read", "write", "manage"];

export const ACCESS_LABEL: Record<OAuthAccess, string> = {
  read: "Read only",
  write: "Read & edit",
  manage: "Full control",
};

export const ACCESS_HINT: Record<OAuthAccess, string> = {
  read: "See your bases, tables and records. Cannot change anything.",
  write: "Also create, edit and delete records, tables, fields, views and automations in your bases.",
  manage:
    "Also manage workspaces, members, invites and settings, and use the admin pages if you are an administrator. Passwords, two-factor settings, sessions and tokens are never reachable.",
};

export function isAccess(value: string | null | undefined): value is OAuthAccess {
  return value === "read" || value === "write" || value === "manage";
}

/** The access level a grant amounts to. */
export function accessOf(grant: { write: boolean; manage: boolean }): OAuthAccess {
  return grant.write && grant.manage ? "manage" : grant.write ? "write" : "read";
}

/** Leave the app for an address on another origin (the app's redirect). A function of its own so tests can observe it. */
export function followRedirect(url: string): void {
  window.location.assign(url);
}
