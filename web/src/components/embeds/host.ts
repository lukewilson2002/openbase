/**
 * Where embeds come alive (REC-6). Only the Page of a record, opened by a signed-in person on the record page,
 * provides a host; everywhere else rich text is shown (public share pages, forms, comments, grid cells, emails)
 * there is none, and an embed there is a static "Embedded view" box that fetches nothing. The host carries what a
 * live embed needs of the record page it sits on, so an embed reads the page's own state and never loads its own.
 */
import { createContext, useContext } from "react";
import type { BaseSchema, Field, Table, TableRecord } from "@/api/types";
import type { FormatCtx } from "@/lib/cells/format";
import type { EditValue } from "@/components/record/editors/env";

export interface EmbedHost {
  /** The folder the record is in. */
  schema: BaseSchema;
  /** The record's collection and the record itself, as the page has them now (a link added here shows at once). */
  table: Table;
  record: TableRecord;
  /** The person's role in the folder: editors and up can add links. */
  role: string;
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  /** Saves a value of the record the way the page does (optimistically, with the page's save status). */
  save: (field: Field, edit: EditValue) => void;
}

const EmbedHostContext = createContext<EmbedHost | null>(null);

export const EmbedHostProvider = EmbedHostContext.Provider;

/** The record page an embed is on, or null where embeds are not alive. */
export function useEmbedHost(): EmbedHost | null {
  return useContext(EmbedHostContext);
}
