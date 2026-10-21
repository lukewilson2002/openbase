import { useCallback, useEffect, useRef } from "react";

/** How long typing in a rich or multiline text field pauses before the expanded record saves it. */
export const AUTOSAVE_MS = 700;

/**
 * Debounced saving for multiline text in the expanded record: `change(text)` after every edit saves the
 * latest text once typing pauses, `flush()` saves it now (blur), and whatever is still waiting is
 * saved when the editor goes away (the record closes, another record opens). Text equal to what
 * was last saved is never saved again, and `discard()` forgets unsaved text (Escape).
 */
export function useAutosave(saved: string, commit: (text: string) => void, ms = AUTOSAVE_MS) {
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

  return { change, flush, discard };
}
