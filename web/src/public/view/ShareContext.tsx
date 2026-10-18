/** What the cells of a shared view need to know about the share they belong to. */
import { createContext, useContext } from "react";
import type { FormatCtx } from "@/lib/cells/format";

export interface ShareCtx {
  token: string;
  /** The password the visitor entered; null for links without one. */
  password: string | null;
  format: FormatCtx;
}

const ShareContext = createContext<ShareCtx | null>(null);

export const ShareProvider = ShareContext.Provider;

export function useShare(): ShareCtx {
  const ctx = useContext(ShareContext);
  if (!ctx) throw new Error("useShare must be used inside a <ShareProvider>");
  return ctx;
}

/** The share the page belongs to, or null outside of a shared page (rendering that is also used elsewhere). */
export function useShareOrNull(): ShareCtx | null {
  return useContext(ShareContext);
}
