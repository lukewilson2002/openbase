/**
 * Everything the non-grid views have in common: current user and time zone, collaborators, the
 * formatting and editing environment, the view config (saved through `useViewConfig`), search,
 * record writes and the `?record=` URL parameter of the expanded record.
 */
import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { Collaborator, TransientConfig, ViewConfig } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import type { EditorEnv } from "@/components/record/editors/env";
import { useDebounced } from "@/components/record/editors/useDebounced";
import { queryRelevantKey } from "@/components/viewbar/config";
import { browserTimeZone } from "@/lib/format";
import { atLeast } from "@/lib/roles";
import type { FormatCtx } from "@/lib/cells/format";
import { useViewConfig, type ViewConfigApi } from "../grid/useViewConfig";
import type { ViewProps } from "../types";
import { useRecordWrites, type RecordWrites } from "./useRecordWrites";

export interface ViewSetup extends ViewProps {
  cfg: ViewConfigApi;
  /** Saved plus pending config (what to render). */
  config: ViewConfig;
  /** Hash of the saved config the record query depends on. */
  configKey: string;
  /**
   * The request-only filter/sort/group override of people who cannot save the view (null for
   * everyone else, or when nothing differs from the saved config). Every query this view makes
   * must send it, and it is part of the query's cache key.
   */
  transient: TransientConfig | null;
  timeZone: string;
  canEdit: boolean;
  canCreateOptions: boolean;
  currentUserId: string | null;
  people: readonly Collaborator[];
  emails: ReadonlyMap<string, string>;
  format: FormatCtx;
  editorEnv: EditorEnv;
  search: string;
  setSearch(s: string): void;
  searchOpen: boolean;
  setSearchOpen(open: boolean): void;
  /** Search text after the typing pause: use this in queries. */
  debouncedSearch: string;
  writes: RecordWrites;
  openRecordId: string | null;
  openRecord(recordId: string | null): void;
}

export function useViewSetup({ schema, table, view, role }: ViewProps): ViewSetup {
  const me = useMe();
  const [searchParams, setSearchParams] = useSearchParams();
  const timeZone = me.data?.timezone || browserTimeZone();
  const canEdit = atLeast(role, "editor");
  const canCreateOptions = atLeast(role, "creator");

  const collaborators = useQuery({ queryKey: keys.baseCollaborators(schema.id), queryFn: () => api.bases.collaborators(schema.id), staleTime: 60_000 });
  const people = useMemo(() => collaborators.data ?? [], [collaborators.data]);
  const emails = useMemo(() => new Map(people.map((u) => [u.id, u.email] as const)), [people]);
  const userNames = useMemo(() => new Map(people.map((u) => [u.id, u.name] as const)), [people]);
  const format = useMemo<FormatCtx>(() => ({ timeZone, userName: (id) => userNames.get(id), userEmail: (id) => emails.get(id) }), [timeZone, userNames, emails]);
  const currentUserId = me.data?.id ?? null;
  const editorEnv = useMemo<EditorEnv>(
    () => ({ baseId: schema.id, tableId: table.id, collaborators: people, timeZone, canCreateOptions, format, currentUserId }),
    [schema.id, table.id, people, timeZone, canCreateOptions, format, currentUserId],
  );

  const cfg = useViewConfig(schema, table, view, role);
  const configKey = useMemo(() => queryRelevantKey(cfg.queryConfig), [cfg.queryConfig]);

  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const debouncedSearch = useDebounced(search.trim(), 250);

  const writes = useRecordWrites({ tableId: table.id, fields: table.fields, canEdit });

  const openRecordId = searchParams.get("record");
  const openRecord = useCallback(
    (recordId: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (recordId) next.set("record", recordId);
          else next.delete("record");
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  return {
    schema,
    table,
    view,
    role,
    cfg,
    config: cfg.config,
    configKey,
    transient: cfg.transient,
    timeZone,
    canEdit,
    canCreateOptions,
    currentUserId,
    people,
    emails,
    format,
    editorEnv,
    search,
    setSearch,
    searchOpen,
    setSearchOpen,
    debouncedSearch,
    writes,
    openRecordId,
    openRecord,
  };
}
