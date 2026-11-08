/**
 * Where the person last was, per device: the last view of each table and the last table of each
 * folder (a base, in the code). The sidebar's rows open these instead of the first one, and
 * `BaseShell` writes them whenever it shows a view. Ids may be stale (a deleted view), so readers
 * check them against what exists. Storage may be missing or blocked: every access is guarded and
 * nothing is then remembered, so rows fall back to the first table or view.
 */
const KEY = "ob-last-place";

interface Memory {
  tables: Record<string, string>;
  projects: Record<string, string>;
}

function strings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function read(): Memory {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      const { tables, projects } = parsed as Record<string, unknown>;
      return { tables: strings(tables), projects: strings(projects) };
    }
  } catch {
    /* unreadable or blocked storage: nothing remembered */
  }
  return { tables: {}, projects: {} };
}

/** Remembers the view on screen, and with it its table in its folder. */
export function rememberPlace(p: { baseId: string; tableId: string; viewId: string }): void {
  try {
    const memory = read();
    if (memory.tables[p.tableId] === p.viewId && memory.projects[p.baseId] === p.tableId) return;
    memory.tables[p.tableId] = p.viewId;
    memory.projects[p.baseId] = p.tableId;
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* storage unavailable (private mode, quota): the rows open the first table or view */
  }
}

/** The view last used in a table, if any. */
export function lastViewOf(tableId: string): string | undefined {
  return read().tables[tableId];
}

/** The table last opened in a folder, if any. */
export function lastTableOf(baseId: string): string | undefined {
  return read().projects[baseId];
}
