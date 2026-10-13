/** What every part of the automation editor needs to know about the base and the person editing. */
import { createContext, useContext } from "react";
import type { BaseSchema, Collaborator } from "@/api/types";

export interface AutomationEnv {
  schema: BaseSchema;
  collaborators: readonly Collaborator[];
  /** `GET /api/setup` says whether SMTP is configured; the send_email action needs it. */
  emailEnabled: boolean;
  /** Viewer's IANA zone. */
  timeZone: string;
  currentUserId: string | null;
}

const Ctx = createContext<AutomationEnv | null>(null);

export const AutomationEnvProvider = Ctx.Provider;

export function useAutomationEnv(): AutomationEnv {
  const env = useContext(Ctx);
  if (!env) throw new Error("useAutomationEnv must be used inside an <AutomationEnvProvider>");
  return env;
}
