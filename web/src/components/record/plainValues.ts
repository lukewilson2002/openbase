import { createContext, useContext } from "react";

/**
 * A record's values drawn inside something that is itself the control (an option of a listbox, whose focus stays in its
 * search field): links, linked-record chips and "+N more" are then text, not controls nested in the option, which a
 * screen reader cannot reach and the accessibility rules do not allow (A11Y-7).
 */
export const PlainValues = createContext(false);
export const usePlainValues = () => useContext(PlainValues);
