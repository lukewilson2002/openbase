import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ACCENT_THEMES, DEFAULT_ACCENT, type Accent } from "./accents";
import { readStoredAccent, readStoredMode, resolveTheme, storeAccent, storeMode, systemPrefersDark, type ResolvedTheme, type ThemeMode } from "./theme";

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** The accent colour on this device; the account's copy is kept in step by `useAccent`. */
  accent: Accent;
  setAccent: (accent: Accent) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [accent, setAccentState] = useState<Accent>(readStoredAccent);
  const [prefersDark, setPrefersDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved = resolveTheme(mode, prefersDark);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);

  useEffect(() => {
    document.documentElement.setAttribute("data-accent", accent);
    // The browser's own chrome (a phone's address bar, an installed app's title bar) follows too.
    // Blue, the default, keeps the page's own value, the one the web app manifest gives too.
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) {
      meta.dataset.original ??= meta.getAttribute("content") ?? "";
      meta.setAttribute("content", accent === DEFAULT_ACCENT ? meta.dataset.original : ACCENT_THEMES[accent].light.primary.toUpperCase());
    }
  }, [accent]);

  const setMode = useCallback((next: ThemeMode) => {
    storeMode(next);
    setModeState(next);
  }, []);

  const setAccent = useCallback((next: Accent) => {
    storeAccent(next);
    setAccentState(next);
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode, accent, setAccent }), [mode, resolved, setMode, accent, setAccent]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
