/**
 * Everything the non-grid views have in common: current user and time zone, collaborators, the
 * formatting and editing environment, the view config (saved through `useViewConfig`), search,
 * record writes, and opening a record as its page.
 */
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
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
import { isFiltered } from "./filtered";
import { useResetFilters } from "./useResetFilters";
import { personColors } from "@/lib/colors";
import { linkedColorIn, type FormatCtx } from "@/lib/cells/format";
import { useRecordNavigation } from "@/record/navigation";
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
  /** Search text after the typing pause: use this in queries. */
  debouncedSearch: string;
  /** The filter or the search narrows the view: with no records it is "filtered to nothing", not an empty collection (COL-9). */
  filtered: boolean;
  /** "Reset" in the filtered-empty state: drops the draft's filter and the search, back to the view as saved. */
  resetFilters(): void;
  writes: RecordWrites;
  /** Delete and duplicate for cards and rows (the confirmation for several is drawn by `ViewFrame`). */
  actions: RecordActions;
  /** Opens a record as its page; previous and next there follow this view's order. */
  openRecord(recordId: string): void;
  /** The ids of the records in the order the layout shows them, which `ViewFrame` keeps up to date for `openRecord` to hand over. */
  stepOrder: RefObject<readonly string[] | undefined>;
  /**
   * The way a view adds a record: creates it (starting from the values of the view's filter, then
   * `values`, e.g. the stack or group it is added to) and opens its page with the title ready for typing.
   * Resolves with the record, or null when it was not created (also while an earlier add is still on its way).
   */
  addRecord(values?: Record<string, unknown>, opts?: { afterRecordId?: string }): Promise<TableRecord | null>;
}

export function useViewSetup({ schema, table, view, role }: ViewProps): ViewSetup {
  const me = useMe();
  const nav = useRecordNavigation();
  const timeZone = me.data?.timezone || browserTimeZone();
  const canEdit = atLeast(role, "editor");
  const canCreateOptions = atLeast(role, "creator");

  const collaborators = useQuery({ queryKey: keys.baseCollaborators(schema.id), queryFn: () => api.bases.collaborators(schema.id), staleTime: 60_000 });
  const people = useMemo(() => collaborators.data ?? [], [collaborators.data]);
  const emails = useMemo(() => new Map(people.map((u) => [u.id, u.email] as const)), [people]);
  const userNames = useMemo(() => new Map(people.map((u) => [u.id, u.name] as const)), [people]);
  const colors = useMemo(() => personColors(people), [people]);
  const format = useMemo<FormatCtx>(() => ({ timeZone, userName: (id) => userNames.get(id), userEmail: (id) => emails.get(id), userColor: (id) => colors.get(id), linkedColor: linkedColorIn(schema.tables) }), [timeZone, userNames, emails, colors, schema.tables]);
  const currentUserId = me.data?.id ?? null;
  const editorEnv = useMemo<EditorEnv>(
    () => ({ baseId: schema.id, tableId: table.id, collaborators: people, timeZone, canCreateOptions, format, currentUserId, schema }),
    [schema, table.id, people, timeZone, canCreateOptions, format, currentUserId],
  );

  const cfg = useViewConfig(schema, table, view, role);
  const configKey = useMemo(() => queryRelevantKey(cfg.queryConfig), [cfg.queryConfig]);

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search.trim(), 250);

  const filtered = isFiltered(cfg.config, debouncedSearch);
  const resetFilters = useResetFilters(cfg, view, search, setSearch);

  const writes = useRecordWrites({ baseId: schema.id, viewId: view.id, tableId: table.id, fields: table.fields, canEdit, queryConfig: cfg.queryConfig, currentUserId });
  const actions = useRecordActions({ writes, role, canEdit });

  const baseId = schema.id;
  const tableId = table.id;
  const viewId = view.id;
  const stepOrder = useRef<readonly string[] | undefined>(undefined);
  const openRecord = useCallback((recordId: string) => nav.open({ baseId, tableId, recordId, viewId }, { order: stepOrder.current }), [nav, baseId, tableId, viewId]);
  const addRecord = useCallback<ViewSetup["addRecord"]>(
    async (values = {}, opts) => {
      const created = await writes.create(values, opts);
      if (created) openRecord(created.id);
      return created;
    },
    [writes, openRecord],
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
    debouncedSearch,
    filtered,
    resetFilters,
    writes,
    actions,
    openRecord,
    stepOrder,
    addRecord,
  };
}
