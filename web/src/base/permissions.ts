import type { View } from "@/api/types";
import { atLeast } from "@/lib/roles";

/** UI-side permission rules for the base shell. The server enforces the same rules authoritatively. */
export const basePermissions = {
  /** Rename the base, change its colour. */
  editBase: (role: string) => atLeast(role, "creator"),
  /** Add, rename, duplicate, delete tables. */
  manageTables: (role: string) => atLeast(role, "creator"),
  /** Create a view (editors create personal views only). */
  createView: (role: string) => atLeast(role, "editor"),
  /** Create views that other people see. */
  createSharedView: (role: string) => atLeast(role, "creator"),
  /** Rename, duplicate, delete or reconfigure a view. Locked shared views need a creator. */
  configureView: (role: string, view: Pick<View, "personal" | "locked">) => {
    if (view.personal) return atLeast(role, "editor");
    return atLeast(role, "creator");
  },
  /** Lock or unlock a shared view. */
  lockView: (role: string, view: Pick<View, "personal">) => !view.personal && atLeast(role, "creator"),
  /** Open the automations page, and create, edit, test, enable and delete automations. */
  manageAutomations: (role: string) => atLeast(role, "creator"),
  /**
   * The server lets editors read an automation's run history, but listing automations (the only way to learn their ids)
   * needs a creator, so the UI offers runs through the automations page to creators only.
   */
  viewAutomationRuns: (role: string) => atLeast(role, "editor"),
  /** See and change base-level members and invites. */
  manageSharing: (role: string) => atLeast(role, "creator"),
};
