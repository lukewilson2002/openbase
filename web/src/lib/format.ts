/** Server timestamps are Unix milliseconds (`db::now_ms`). */
export function formatDateTime(ms: number | null | undefined, timeZone?: string | null): string {
  if (ms === null || ms === undefined) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timeZone || undefined,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export function formatDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(ms));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

/** Supported IANA zones, with a small fallback for engines lacking `Intl.supportedValuesOf`. */
export function listTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.("timeZone");
    if (zones && zones.length > 0) return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    /* fall through */
  }
  return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney"];
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Only same-origin absolute paths are valid post-login targets (no open redirects). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

/**
 * Paths the server itself answers (not the web app's router): the OAuth authorization endpoint
 * sends a visitor to sign in with itself as `next`, and the way back must be a full page load.
 */
export function isServerPath(next: string): boolean {
  return next === "/oauth/authorize" || next.startsWith("/oauth/authorize?");
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Absolute URL for a path or a path-only server URL (invite and reset links). */
export function absoluteUrl(urlOrPath: string): string {
  if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
  return `${window.location.origin}${urlOrPath.startsWith("/") ? "" : "/"}${urlOrPath}`;
}
