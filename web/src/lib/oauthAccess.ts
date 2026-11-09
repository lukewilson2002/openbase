/** The access levels an OAuth app can be given, lowest first (they mirror the server's `Access`). */
export type OAuthAccess = "read" | "write" | "manage";

export const ACCESS_ORDER: OAuthAccess[] = ["read", "write", "manage"];

export const ACCESS_LABEL: Record<OAuthAccess, string> = {
  read: "Read",
  write: "Read and write",
  manage: "Full control",
};

/** The same three levels as an API token names them (AGT-5). */
export const TOKEN_ACCESS_LABEL: Record<OAuthAccess, string> = { ...ACCESS_LABEL, manage: "Full access" };

/** What each level allows, in one plain sentence (AGT-2, AGT-5). */
export const ACCESS_HINT: Record<OAuthAccess, string> = {
  read: "Can see your folders, collections and records, and cannot change anything.",
  write: "Can also create, change and delete records, collections, properties, views and automations.",
  manage: "Can also create and delete workspaces and folders, manage members, invites and settings, and use the admin pages if you are an administrator.",
};

/** True for a level a limited-to-some-folders app or token cannot be given: managing reaches beyond single folders. */
export const NEEDS_ALL_FOLDERS: OAuthAccess = "manage";

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
