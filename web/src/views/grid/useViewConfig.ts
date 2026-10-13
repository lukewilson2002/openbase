/**
 * Reading and changing a view's config.
 *
 * - Whoever may reconfigure the view (editors on unlocked shared views, creators on locked ones,
 *   the owner of a personal view) persists changes with `PATCH /api/views/{id}` (a full config
 *   replacement), applied optimistically to the cached base schema and debounced.
 * - Everyone else keeps presentational changes (hidden fields, column order and widths, frozen
 *   columns, row height) locally in localStorage; query-affecting changes (filter, sorts,
 *   groups, colours, summaries) are not available to them, because the server runs the saved
 *   config (see notes_for_integrator: QueryRequest has no config override).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { schemaApi } from "@/api/records";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View, ViewConfig } from "@/api/types";
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

function storageKey(viewId: string): string {
  return `og-view-local:${viewId}`;
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
   * The config the server will use for queries: only the saved one. Query keys must be built
   * from this (not `config`), otherwise a page could be fetched before the PATCH lands and be
   * cached under the new key with the old results.
   */
  queryConfig: ViewConfig;
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
  const [saving, setSaving] = useState(false);
  const fieldIds = useMemo(() => new Set(table.fields.map((f) => f.id)), [table.fields]);

  // A different view starts from its own saved state.
  useEffect(() => {
    setLocal(readLocal(view.id));
    setPending(null);
    pendingRef.current = null;
  }, [view.id]);

  const config = useMemo<ViewConfig>(() => {
    const base = pending ?? view.config;
    return canConfigure ? base : { ...base, ...local };
  }, [pending, view.config, canConfigure, local]);

  const configRef = useRef(config);
  configRef.current = config;

  const flush = useCallback(async () => {
    timer.current = null;
    const next = pendingRef.current;
    if (!next) return;
    const seq = ++saveSeq.current;
    setSaving(true);
    try {
      const saved = await schemaApi.updateView(view.id, { config: next });
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
    },
    [canConfigure, fieldIds, flush, view.id],
  );

  return { config, queryConfig: view.config, canConfigure, saving: saving || pending !== null, update };
}

function replaceViewConfig(schema: BaseSchema, tableId: string, viewId: string, config: ViewConfig): BaseSchema {
  return {
    ...schema,
    tables: schema.tables.map((t) => (t.id === tableId ? { ...t, views: t.views.map((v) => (v.id === viewId ? { ...v, config } : v)) } : t)),
  };
}
