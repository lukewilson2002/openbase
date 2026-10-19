/**
 * Reading and changing a view's config.
 *
 * - Whoever may reconfigure the view (editors on unlocked shared views, creators on locked ones,
 *   the owner of a personal view) persists changes with `PATCH /api/views/{id}` (a full config
 *   replacement), applied optimistically to the cached base schema and debounced.
 * - Everyone else keeps presentational changes (hidden fields, column order and widths, frozen
 *   columns, row height) locally in localStorage, and can still filter, sort and group for
 *   themselves: those three travel with each query as the `transient` override
 *   (`TransientConfig`, docs/plans §3.1), are never saved to the view, and are shown as "not
 *   saved". Colours and summaries stay read-only for them (the override does not cover them).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Filter, Sort, Table, TransientConfig, View, ViewConfig } from "@/api/types";
import { useToast } from "@/components/ui/toast";
import { queryRelevantKey, sanitizeConfig } from "@/components/viewbar/config";
import { atLeast } from "@/lib/roles";

const SAVE_DELAY_MS = 350;
const LOCAL_KEYS = ["hidden_fields", "field_order", "field_widths", "frozen_columns", "row_height"] as const;
type LocalKey = (typeof LOCAL_KEYS)[number];
type LocalOverlay = Partial<Pick<ViewConfig, LocalKey>>;

/** Who may change the saved config of `view`. */
export function canConfigureView(role: string, view: Pick<View, "personal" | "locked">): boolean {
  if (view.personal) return atLeast(role, "editor");
  return view.locked ? atLeast(role, "creator") : atLeast(role, "editor");
}

/**
 * The field layout (order and hidden fields) a record opened from any other view type shows: the
 * table's grid view's, as this person sees that grid. The first shared grid wins over personal ones;
 * null when the table has no grid view.
 */
export function gridRecordLayout(table: Pick<Table, "views">, role: string): Pick<ViewConfig, "field_order" | "hidden_fields"> | null {
  const grids = table.views.filter((v) => v.type === "grid");
  const grid = grids.find((v) => !v.personal) ?? grids[0];
  if (!grid) return null;
  const local = canConfigureView(role, grid) ? {} : readLocal(grid.id);
  return { field_order: local.field_order ?? grid.config.field_order, hidden_fields: local.hidden_fields ?? grid.config.hidden_fields };
}

function storageKey(viewId: string): string {
  return `ob-view-local:${viewId}`;
}

function transientKey(viewId: string): string {
  return `ob-view-transient:${viewId}`;
}

const EMPTY_FILTER: Filter = { conjunction: "and", items: [] };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The parts of `next` (filter, sorts, groups) that differ from the saved config, as a request override. */
export function diffTransient(saved: ViewConfig, next: ViewConfig): TransientConfig | null {
  const t: TransientConfig = {};
  // "No filter" is sent as a filter without items: leaving the part out would keep the saved one.
  if (!sameJson(saved.filter, next.filter)) t.filter = next.filter && next.filter.items.length > 0 ? next.filter : EMPTY_FILTER;
  if (!sameJson(saved.sorts, next.sorts)) t.sorts = next.sorts;
  if (!sameJson(saved.groups, next.groups)) t.groups = next.groups;
  return Object.keys(t).length > 0 ? t : null;
}

/** The config the server runs for a query carrying `transient`. */
export function applyTransient(saved: ViewConfig, transient: TransientConfig | null): ViewConfig {
  if (!transient) return saved;
  return {
    ...saved,
    filter: transient.filter !== undefined && transient.filter !== null ? (transient.filter.items.length > 0 ? transient.filter : null) : saved.filter,
    sorts: (transient.sorts ?? saved.sorts) as Sort[],
    groups: (transient.groups ?? saved.groups) as Sort[],
  };
}

function readTransient(viewId: string): TransientConfig | null {
  try {
    const raw = localStorage.getItem(transientKey(viewId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as TransientConfig) : null;
  } catch {
    return null;
  }
}

function writeTransient(viewId: string, t: TransientConfig | null): void {
  try {
    if (t) localStorage.setItem(transientKey(viewId), JSON.stringify(t));
    else localStorage.removeItem(transientKey(viewId));
  } catch {
    /* storage unavailable: the override lasts for this page view */
  }
}

function readLocal(viewId: string): LocalOverlay {
  try {
    const raw = localStorage.getItem(storageKey(viewId));
    return raw ? (JSON.parse(raw) as LocalOverlay) : {};
  } catch {
    return {};
  }
}

function writeLocal(viewId: string, overlay: LocalOverlay): void {
  try {
    localStorage.setItem(storageKey(viewId), JSON.stringify(overlay));
  } catch {
    /* storage unavailable: the change lasts for this page view */
  }
}

export interface ViewConfigApi {
  /** The config the grid should render: saved config plus any unsaved or local changes. */
  config: ViewConfig;
  /**
   * The config the server will use for queries: the saved one, plus the `transient` override
   * for people who cannot save. Query keys must be built from this (not `config`), otherwise a
   * page could be fetched before the PATCH lands and be cached under the new key with the old
   * results.
   */
  queryConfig: ViewConfig;
  /** The override to send with every query and aggregation request (null for people who can save, or when nothing differs). */
  transient: TransientConfig | null;
  /** Drop the local filter/sort/group and go back to the saved ones. */
  resetTransient(): void;
  canConfigure: boolean;
  /** True while a change is waiting to be saved or in flight. */
  saving: boolean;
  /** Apply a pure mutation (see components/viewbar/config.ts). */
  update(mutate: (c: ViewConfig) => ViewConfig): void;
}

export function useViewConfig(schema: BaseSchema, table: Table, view: View, role: string): ViewConfigApi {
  const qc = useQueryClient();
  const toast = useToast();
  const canConfigure = canConfigureView(role, view);
  const [pending, setPending] = useState<ViewConfig | null>(null);
  const pendingRef = useRef<ViewConfig | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSeq = useRef(0);
  const [local, setLocal] = useState<LocalOverlay>(() => readLocal(view.id));
  const [storedTransient, setStoredTransient] = useState<TransientConfig | null>(() => readTransient(view.id));
  const [saving, setSaving] = useState(false);
  const fieldIds = useMemo(() => new Set(table.fields.map((f) => f.id)), [table.fields]);

  // A different view starts from its own saved state.
  useEffect(() => {
    setLocal(readLocal(view.id));
    setStoredTransient(readTransient(view.id));
    setPending(null);
    pendingRef.current = null;
  }, [view.id]);

  // Fields that were deleted since the override was made are dropped from it.
  const transient = useMemo<TransientConfig | null>(() => {
    if (canConfigure || !storedTransient) return null;
    return diffTransient(view.config, sanitizeConfig(applyTransient(view.config, storedTransient), fieldIds));
  }, [canConfigure, storedTransient, view.config, fieldIds]);

  const queryConfig = useMemo(() => applyTransient(view.config, transient), [view.config, transient]);

  const config = useMemo<ViewConfig>(() => {
    if (canConfigure) return pending ?? view.config;
    return { ...queryConfig, ...local };
  }, [pending, view.config, queryConfig, canConfigure, local]);

  const configRef = useRef(config);
  configRef.current = config;

  const flush = useCallback(async () => {
    timer.current = null;
    const next = pendingRef.current;
    if (!next) return;
    const seq = ++saveSeq.current;
    setSaving(true);
    try {
      const saved = await api.views.update(view.id, { config: next });
      if (seq === saveSeq.current) {
        pendingRef.current = null;
        setPending(null);
      }
      // Reflect the server's version in the cached schema (the PATCH answers with the view).
      qc.setQueryData<BaseSchema>(keys.base(schema.id), (old) => (old ? replaceViewConfig(old, table.id, view.id, saved?.config ?? next) : old));
    } catch (e) {
      if (seq === saveSeq.current) {
        pendingRef.current = null;
        setPending(null);
        toast.error(e, "Could not save the view");
      }
    } finally {
      if (seq === saveSeq.current) setSaving(false);
    }
  }, [qc, schema.id, table.id, view.id, toast]);

  // Save what is pending when leaving the view.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
    },
    [flush],
  );

  const update = useCallback(
    (mutate: (c: ViewConfig) => ViewConfig) => {
      const prev = configRef.current;
      const next = sanitizeConfig(mutate(prev), fieldIds);
      if (canConfigure) {
        pendingRef.current = next;
        setPending(next);
        if (timer.current) clearTimeout(timer.current);
        // Changes the record query depends on save right away; widths, order and the like are debounced.
        const urgent = queryRelevantKey(prev) !== queryRelevantKey(next) || JSON.stringify(prev.summaries) !== JSON.stringify(next.summaries);
        if (urgent) void flush();
        else timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
        return;
      }
      const overlay: LocalOverlay = {};
      for (const k of LOCAL_KEYS) (overlay as Record<string, unknown>)[k] = next[k];
      setLocal(overlay);
      writeLocal(view.id, overlay);
      const nextTransient = diffTransient(view.config, next);
      setStoredTransient(nextTransient);
      writeTransient(view.id, nextTransient);
    },
    [canConfigure, fieldIds, flush, view.id, view.config],
  );

  const resetTransient = useCallback(() => {
    setStoredTransient(null);
    writeTransient(view.id, null);
  }, [view.id]);

  return { config, queryConfig, transient, resetTransient, canConfigure, saving: saving || pending !== null, update };
}

function replaceViewConfig(schema: BaseSchema, tableId: string, viewId: string, config: ViewConfig): BaseSchema {
  return {
    ...schema,
    tables: schema.tables.map((t) => (t.id === tableId ? { ...t, views: t.views.map((v) => (v.id === viewId ? { ...v, config } : v)) } : t)),
  };
}
