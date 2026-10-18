/**
 * What the expanded record tells a pop-over editor about the edit it is part of. A field there is read
 * until it is clicked, and the click starts an edit: the editor opens its pop-over straight away
 * (`openOnMount`) and says when the pop-over has closed (`popupClosed`), which ends the edit, since the
 * pop-over and the editor's own button are the only places the person can be. Everywhere else (the
 * Inbox form, the grid) there is no session and the editors behave as they always did.
 */
import { createContext, useContext } from "react";

export interface EditSession {
  /** The pop-over starts open. */
  openOnMount: boolean;
  /** The pop-over closed (Escape, a click outside, or a pick that finished the edit). */
  popupClosed(): void;
}

const EditSessionContext = createContext<EditSession | null>(null);

export const EditSessionProvider = EditSessionContext.Provider;

export function useEditSession(): EditSession | null {
  return useContext(EditSessionContext);
}
