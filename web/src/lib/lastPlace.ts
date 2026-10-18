/**
 * Where the person last was, per device: the last view of each table, the last table of each
 * project and the last project of each workspace. The menu's rows open these instead of the first
 * one, and `BaseShell` writes them whenever it shows a view. Ids may be stale (a deleted view), so
 * readers check them against what exists. Storage may be missing or blocked: every access is guarded
 * and nothing is then remembered, so rows fall back to the first table or view.
 */
import type { WorkspaceSummary } from "@/api/types";

const KEY = "ob-last-place";

interface Memory {
  tables: Record<string, string>;
  projects: Record<string, string>;
  workspaces: Record<string, string>;
}

function strings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function read(): Memory {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      const { tables, projects, workspaces } = parsed as Record<string, unknown>;
      return { tables: strings(tables), projects: strings(projects), workspaces: strings(workspaces) };
    }
  } catch {
    /* unreadable or blocked storage: nothing remembered */
  }
  return { tables: {}, projects: {}, workspaces: {} };
}

/** Remembers the view on screen, and with it its table in its project (a base, in the code) in its workspace. */
export function rememberPlace(p: { workspaceId: string; baseId: string; tableId: string; viewId: string }): void {
  try {
    const memory = read();
    if (memory.tables[p.tableId] === p.viewId && memory.projects[p.baseId] === p.tableId && memory.workspaces[p.workspaceId] === p.baseId) return;
    memory.tables[p.tableId] = p.viewId;
    memory.projects[p.baseId] = p.tableId;
    memory.workspaces[p.workspaceId] = p.baseId;
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* storage unavailable (private mode, quota): the rows open the first table or view */
  }
}

/** The view last used in a table, if any. */
export function lastViewOf(tableId: string): string | undefined {
  return read().tables[tableId];
}

/** The table last opened in a project, if any. */
export function lastTableOf(baseId: string): string | undefined {
  return read().projects[baseId];
}

/** The project last opened in a workspace, if any. */
export function lastBaseOf(workspaceId: string): string | undefined {
  return read().workspaces[workspaceId];
}

/** The project a workspace opens: the one last opened that still exists, else its first. */
export function projectToOpen(ws: Pick<WorkspaceSummary, "id" | "bases">): string | undefined {
  const last = lastBaseOf(ws.id);
  return (ws.bases.find((b) => b.id === last) ?? ws.bases[0])?.id;
}

/**
 * The address of a project (a base) that opens where the person left off: its last table and that
 * table's last view. Unchecked against the schema; `BaseShell` falls back to the first table or view
 * when either has gone.
 */
export function projectPath(baseId: string): string {
  const table = lastTableOf(baseId);
  const view = table ? lastViewOf(table) : undefined;
  return `/base/${baseId}${table ? `/${table}${view ? `/${view}` : ""}` : ""}`;
}
