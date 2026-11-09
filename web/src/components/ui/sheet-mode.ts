import { createContext } from "react";

/**
 * Whether the menu items in scope are rows of a bottom sheet rather than items of a dropdown. A menu draws as a
 * dropdown beside its button on a desktop and as a sheet on a phone (PH-3); the items read this to match.
 */
export const SheetModeContext = createContext(false);
