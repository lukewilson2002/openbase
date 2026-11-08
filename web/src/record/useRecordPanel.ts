/**
 * Which side panel of the record page is open, Comments or History, kept per device (REC-7): a desktop that had
 * Comments open when a record was left finds it open on the next one. A phone opens each in a full-screen sheet,
 * and a sheet that opens by itself on arrival would cover the page, so a phone neither restores nor remembers.
 */
import { useCallback, useState } from "react";
import type { RecordPanelKind } from "./RecordBar";

export const RECORD_PANEL_KEY = "ob-record-panel";

function read(): RecordPanelKind | null {
  try {
    const v = localStorage.getItem(RECORD_PANEL_KEY);
    return v === "comments" || v === "history" ? v : null;
  } catch {
    // Unreadable or blocked storage: the panel starts closed.
    return null;
  }
}

function write(panel: RecordPanelKind | null): void {
  try {
    if (panel) localStorage.setItem(RECORD_PANEL_KEY, panel);
    else localStorage.removeItem(RECORD_PANEL_KEY);
  } catch {
    // Storage unavailable (private mode, quota): the choice lasts for this page view.
  }
}

export interface RecordPanelState {
  panel: RecordPanelKind | null;
  /** The panel was opened by the person (not restored on arrival), so it takes the keyboard focus. */
  opened: boolean;
  /** The button of `kind` was pressed: opens that panel, or closes it when it is the one open. */
  toggle(kind: RecordPanelKind): void;
  /** Opens `kind` (the phone's More menu) or, with null, closes the panel. */
  set(panel: RecordPanelKind | null): void;
}

export function useRecordPanel(desktop: boolean): RecordPanelState {
  const [panel, setPanel] = useState<RecordPanelKind | null>(() => (desktop ? read() : null));
  const [opened, setOpened] = useState(false);
  const set = useCallback(
    (next: RecordPanelKind | null) => {
      setPanel(next);
      setOpened(next !== null);
      if (desktop) write(next);
    },
    [desktop],
  );
  const toggle = useCallback((kind: RecordPanelKind) => set(panel === kind ? null : kind), [panel, set]);
  return { panel, opened, toggle, set };
}
