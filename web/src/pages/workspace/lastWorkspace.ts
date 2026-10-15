const KEY = "ob-last-workspace";

/** The workspace opened last on this device, so `/` can go back to it. */
export function readLastWorkspace(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberWorkspace(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: `/` falls back to the first workspace */
  }
}
