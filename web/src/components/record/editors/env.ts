/** Shared context for cell editors (grid overlay and expanded record). */
import { createContext, useContext } from "react";
import type { Collaborator } from "@/api/types";
import type { FormatCtx } from "@/lib/cells/format";

export interface EditorEnv {
  baseId: string;
  tableId: string;
  /** Everyone who can be picked in user fields (and @mentioned). */
  collaborators: readonly Collaborator[];
  /** Viewer's IANA zone. */
  timeZone: string;
  /** Creators and owners may add select options from the editor. */
  canCreateOptions: boolean;
  /** Format context derived from the above. */
  format: FormatCtx;
  /** Id of the signed-in user ("me" in filters, the default for new user cells). */
  currentUserId: string | null;
}

const EditorEnvContext = createContext<EditorEnv | null>(null);

export const EditorEnvProvider = EditorEnvContext.Provider;

export function useEditorEnv(): EditorEnv {
  const env = useContext(EditorEnvContext);
  if (!env) throw new Error("useEditorEnv must be used inside an <EditorEnvProvider>");
  return env;
}

/** The edit a field editor reports: parsed JSON (view form) or text for the host to parse. */
export interface EditValue {
  json?: unknown;
  text?: string;
}

export type Move = readonly [-1 | 0 | 1, -1 | 0 | 1];

export interface FieldEditorCallbacks {
  /** Value so far; the host commits it when the user clicks outside. */
  onChange?: (edit: EditValue) => void;
  /** Accept the value and optionally move the selection. */
  onCommit: (edit: EditValue, move?: Move) => void;
  /** Discard (Escape). */
  onCancel: () => void;
}
