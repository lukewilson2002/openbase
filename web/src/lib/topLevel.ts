/**
 * A workspace's top level and folders, as the person may see them (decision 1, NAV-10). The top level is
 * one project whose collections show directly under the workspace; every other project is a folder.
 * `GET /api/workspaces` lists only the projects the caller can open, and sets `root_base_id` only when the
 * top-level project is one of them, so someone limited to some folders gets those folders and no top level.
 */
import type { BaseSummary, WorkspaceSummary } from "@/api/types";

type WorkspaceBases = Pick<WorkspaceSummary, "bases" | "root_base_id">;

/** The top-level project, when the person can open it. */
export function topLevelOf(ws: WorkspaceBases): BaseSummary | undefined {
  const id = ws.root_base_id;
  // An older response without the pointer still marks the project itself.
  return id ? ws.bases.find((b) => b.id === id) : ws.bases.find((b) => b.is_top_level);
}

/** The folders the person can open, in the workspace's order. */
export function foldersOf(ws: WorkspaceBases): BaseSummary[] {
  const top = topLevelOf(ws);
  return ws.bases.filter((b) => b !== top && !b.is_top_level);
}
