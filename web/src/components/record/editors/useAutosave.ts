import { useCallback, useEffect, useRef } from "react";

/** How long typing in a rich or multiline text field pauses before the expanded record saves it. */
export const AUTOSAVE_MS = 700;

/**
 * Debounced saving for multiline text in the expanded record: `change(text)` after every edit saves the
 * latest text once typing pauses, `flush()` saves it now (blur), and whatever is still waiting is
 * saved when the editor goes away (the record closes, another record opens) and when the page itself
 * goes (a tab closed, a reload, an address typed in the bar), which is told to `commit` as `exit` so it can
 * use a request that outlives the page. Text equal to what was last saved is never saved again, and
 * `discard()` forgets unsaved text (Escape).
 */
export function useAutosave(saved: string, commit: (text: string, exit?: boolean) => void, ms = AUTOSAVE_MS) {
  const last = useRef(saved);
  const latest = useRef(saved);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (latest.current === last.current) return;
    last.current = latest.current;
    commitRef.current(latest.current);
  }, []);

  const change = useCallback(
    (text: string) => {
      latest.current = text;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, ms);
    },
    [flush, ms],
  );

  const discard = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    latest.current = last.current;
  }, []);

  useEffect(() => flush, [flush]);

  // Closing the tab runs neither a blur nor an unmount. A page that goes into the back-forward cache comes back as it was.
  useEffect(() => {
    const onHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      if (latest.current === last.current) return;
      last.current = latest.current;
      commitRef.current(latest.current, true);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  return { change, flush, discard };
}
