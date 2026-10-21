// Keep the storage keys and resolution logic in sync with public/theme-init.js.
import { DEFAULT_ACCENT, isAccent, type Accent } from "./accents";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "ob-theme";
/**
 * The accent colour, mirrored from the account (`User.accent`) so the page paints in it before
 * the profile arrives.
 */
export const ACCENT_STORAGE_KEY = "ob-accent";

export function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

export function storeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* storage unavailable: the choice lasts for this page view only */
  }
}

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

export function readStoredAccent(): Accent {
  try {
    const v = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (isAccent(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_ACCENT;
}

export function storeAccent(accent: Accent): void {
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    /* storage unavailable: the account still has it */
  }
}
