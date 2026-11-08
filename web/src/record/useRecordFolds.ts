/** Whether the record page's two folds ("Show N empty properties", "Show N hidden properties") are open, kept per collection on this device (REC-3). */
import { useCallback, useState } from "react";

export const RECORD_FOLDS_KEY = "ob-record-folds";

export type FoldKind = "empty" | "hidden";
type Folds = Record<FoldKind, boolean>;
type Stored = Record<string, Partial<Folds>>;

function readAll(): Stored {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECORD_FOLDS_KEY) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    // Unreadable or blocked storage: the folds start closed.
    return {};
  }
}

function writeAll(all: Stored): void {
  try {
    localStorage.setItem(RECORD_FOLDS_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable (private mode, quota): the choice lasts for this page view.
  }
}

export function useRecordFolds(tableId: string): [Folds, (kind: FoldKind) => void] {
  const [all, setAll] = useState<Stored>(readAll);
  const toggle = useCallback(
    (kind: FoldKind) => {
      setAll((cur) => {
        // Another tab may have changed the others since this one read them.
        const next = { ...readAll(), ...cur };
        next[tableId] = { ...next[tableId], [kind]: !next[tableId]?.[kind] };
        writeAll(next);
        return next;
      });
    },
    [tableId],
  );
  return [{ empty: all[tableId]?.empty === true, hidden: all[tableId]?.hidden === true }, toggle];
}
