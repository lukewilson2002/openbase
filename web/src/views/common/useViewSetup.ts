/**
 * Everything the non-grid views have in common: current user and time zone, collaborators, the
 * formatting and editing environment, the view config (saved through `useViewConfig`), search,
 * record writes and the `?record=` URL parameter of the expanded record.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { Collaborator, TableRecord, TransientConfig, ViewConfig } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import type { EditorEnv } from "@/components/record/editors/env";
import { useDebounced } from "@/components/record/editors/useDebounced";
import { queryRelevantKey } from "@/components/viewbar/config";
import { browserTimeZone } from "@/lib/format";
import { atLeast } from "@/lib/roles";
import { LINKED_PARAM } from "./RecordPanel";
import { personColors } from "@/lib/colors";
import type { FormatCtx } from "@/lib/cells/format";
import { useViewConfig, type ViewConfigApi } from "../grid/useViewConfig";
import type { ViewProps } from "../types";
import { useRecordActions, type RecordActions } from "./useRecordActions";
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
  /** Delete and duplicate for cards and rows (the confirmation for several is drawn by `ViewFrame`). */
  actions: RecordActions;
  openRecordId: string | null;
  openRecord(recordId: string | null): void;
  /**
   * Opens a record the person just added: its first field starts being edited, and the record is
   * thrown away again when its panel closes with nothing changed (see `RecordWrites.discardIfUntouched`).
   */
  openNewRecord(recordId: string): void;
  /**
   * The way a view adds a record: creates it (starting from the values of the view's filter, then
   * `values`, e.g. the stack or group it is added to) and opens it for typing. Resolves with the record,
   * or null when it was not created (also while an earlier add is still on its way).
   */
  addRecord(values?: Record<string, unknown>, opts?: { afterRecordId?: string }): Promise<TableRecord | null>;
  /** The record that was just added, while it is the one open. */
  newRecordId: string | null;
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
  const colors = useMemo(() => personColors(people), [people]);
  const format = useMemo<FormatCtx>(() => ({ timeZone, userName: (id) => userNames.get(id), userEmail: (id) => emails.get(id), userColor: (id) => colors.get(id) }), [timeZone, userNames, emails, colors]);
  const currentUserId = me.data?.id ?? null;
  const editorEnv = useMemo<EditorEnv>(
    () => ({ baseId: schema.id, tableId: table.id, collaborators: people, timeZone, canCreateOptions, format, currentUserId, schema }),
    [schema, table.id, people, timeZone, canCreateOptions, format, currentUserId],
  );

  const cfg = useViewConfig(schema, table, view, role);
  const configKey = useMemo(() => queryRelevantKey(cfg.queryConfig), [cfg.queryConfig]);

  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const debouncedSearch = useDebounced(search.trim(), 250);

  const writes = useRecordWrites({ tableId: table.id, fields: table.fields, canEdit, queryConfig: cfg.queryConfig, currentUserId });
  const actions = useRecordActions({ writes, role, canEdit });

  const openRecordId = searchParams.get("record");
  const openRecord = useCallback(
    (recordId: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (recordId) next.set("record", recordId);
          else next.delete("record");
          // Linked records opened on top of the record go with it.
          next.delete(LINKED_PARAM);
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );
  // Which record was added a moment ago, so its expanded form starts in edit mode. It is forgotten (and thrown
  // away if nothing was typed in it) once another record, or none, is open.
  const [newId, setNewId] = useState<string | null>(null);
  // The address changes a moment after `newId` is set: the record counts as opened only once it showed up there.
  const sawNewOpen = useRef(false);
  const newIdRef = useRef<string | null>(null);
  newIdRef.current = newId;
  const { discardIfUntouched } = writes;
  useEffect(() => {
    if (!newId) {
      sawNewOpen.current = false;
      return;
    }
    if (openRecordId === newId) {
      sawNewOpen.current = true;
      return;
    }
    if (sawNewOpen.current) {
      sawNewOpen.current = false;
      setNewId(null);
      void discardIfUntouched(newId);
    }
  }, [openRecordId, newId, discardIfUntouched]);
  const openNewRecord = useCallback(
    (recordId: string) => {
      const earlier = newIdRef.current;
      if (earlier && earlier !== recordId) void discardIfUntouched(earlier);
      sawNewOpen.current = false;
      setNewId(recordId);
      openRecord(recordId);
    },
    [openRecord, discardIfUntouched],
  );
  const addRecord = useCallback<ViewSetup["addRecord"]>(
    async (values = {}, opts) => {
      const created = await writes.create(values, opts);
      if (created) openNewRecord(created.id);
      return created;
    },
    [writes, openNewRecord],
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
    actions,
    openRecordId,
    openRecord,
    openNewRecord,
    addRecord,
    newRecordId: newId,
  };
}
