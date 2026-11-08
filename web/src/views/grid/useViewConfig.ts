/**
 * Reading and changing a view's config (COL-5, decision 4): every change is a draft.
 *
 * - `update` writes a draft kept on this device for this person (views/drafts). Nothing reaches the server
 *   but the query settings, which travel with each query as `TransientConfig` so the server computes them
 *   (filter, sorts, groups, row colors, summaries). Nobody else sees a draft.
 * - `updateView` writes the draft to the view (people who may configure it, when the layout is the view's
 *   own; on the default view the layout settings only), and `saveAsView` makes a new view of it.
 * - A form's own settings and fields are the one thing that saves as it is made (`saveNow`): a public form
 *   follows the live form. A save goes out at once, one at a time, the latest state winning.
 * - There is no timer and no "Not saved" state: the draft is the state, and the TemporaryChangesBar says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, TransientConfig, View, ViewConfig, ViewType } from "@/api/types";
import { useToast } from "@/components/ui/toast";
import { sanitizeConfig } from "@/components/viewbar/config";
import { DRAFT_KEYS, IMMEDIATE_KEYS } from "../drafts/classify";
import { applyDraft, applyTransient, changedOnServer, fingerprint, nextDraft, sameSetting, toTransient, type ViewDraft } from "../drafts/draft";
import { canConfigureView, draftActions, draftLayout, type DraftActions } from "../drafts/permissions";
import { readDraft, useDraftUser, useViewDraft, writeDraft } from "../drafts/store";

/**
 * The view that lays out the table's records wherever they are shown outside a grid (the record page,
 * linked records' cards and previews): the table's default grid, as it is saved. A table from before default grids existed uses its first
 * shared grid, else any grid; null when it has none. A person's drafts are for the view they are
 * made in and do not reach the other places records show.
 */
export function recordLayoutView(table: Pick<Table, "views">): View | null {
  const grids = table.views.filter((v) => v.type === "grid");
  return grids.find((v) => v.is_default) ?? grids.find((v) => !v.personal) ?? grids[0] ?? null;
}

/** The field layout (order and hidden fields) of `recordLayoutView`. */
export function gridRecordLayout(table: Pick<Table, "views">): Pick<ViewConfig, "field_order" | "hidden_fields"> | null {
  const grid = recordLayoutView(table);
  return grid ? { field_order: grid.config.field_order, hidden_fields: grid.config.hidden_fields } : null;
}

/**
 * The saved config with a draft's settings laid over it. Only the draft's own settings are cleaned of
 * properties that no longer exist (the saved ones are the server's business), so a draft shows exactly what
 * it changed.
 */
export function effectiveConfig(saved: ViewConfig, draft: ViewDraft | null, fieldIds: ReadonlySet<string>): ViewConfig {
  if (!draft) return saved;
  const merged = applyDraft(saved, draft);
  const cleaned = sanitizeConfig(merged, fieldIds) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...merged };
  for (const key of Object.keys(draft.changes)) out[key] = cleaned[key];
  return out as unknown as ViewConfig;
}

export interface ViewConfigApi {
  /** The config to render: the saved one with this person's draft over it. */
  config: ViewConfig;
  /**
   * The config the server runs for queries: the saved one with the draft's `transient` over it. Query keys
   * are built from this (not `config`): layout settings do not change which records come back.
   */
  queryConfig: ViewConfig;
  /** The query settings of the draft, to send with every query and aggregation request (null when it leaves them alone). */
  transient: TransientConfig | null;
  /** The layout being shown: the view's own, or the one the draft switched to. */
  layout: ViewType;
  /** This person's unsaved changes to the view on this device, if any. */
  draft: ViewDraft | null;
  /** The view was saved by someone else, or on another device, since the draft started. */
  changedOnServer: boolean;
  /** Which of Update view and Save as view the person has. */
  actions: DraftActions;
  /** Whether this person may build the form of this view: a form view they may change (a form shown as a layout of another view is not one). */
  canEditForm: boolean;
  /** Change a draft setting with a pure mutation (see components/viewbar/config.ts). */
  update(mutate: (c: ViewConfig) => ViewConfig): void;
  /** Show the same records in another layout, as a draft. */
  setLayout(type: ViewType): void;
  /** Drop the draft: back to the view as saved. */
  reset(): void;
  /** Write the draft to the view. Resolves true when it was saved. */
  updateView(): Promise<boolean>;
  /** Make a new view of the draft and drop the draft. Throws when the server refuses. */
  saveAsView(input: { name: string; personal: boolean }): Promise<View>;
  /** Save a form's own settings and fields now (the one change that is not a draft). */
  saveNow(mutate: (c: ViewConfig) => ViewConfig): void;
  /** A form change or an Update view is on its way to the server. */
  saving: boolean;
}

export function useViewConfig(schema: BaseSchema, table: Table, view: View, role: string): ViewConfigApi {
  const qc = useQueryClient();
  const toast = useToast();
  const userId = useDraftUser();
  const draft = useViewDraft(view.id);
  const canConfigure = canConfigureView(role, view);
  const fieldIds = useMemo(() => new Set(table.fields.map((f) => f.id)), [table.fields]);
  const [saving, setSaving] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const fieldIdsRef = useRef(fieldIds);
  fieldIdsRef.current = fieldIds;

  // A draft moved over from the old local storage takes this view's fingerprint, and drops what equals the saved view.
  useEffect(() => {
    if (draft && draft.base === null) writeDraft(userId, view.id, nextDraft(draft, view, applyDraft(view.config, draft), draftLayout(view, draft), Date.now()));
  }, [draft, userId, view]);

  const config = useMemo(() => effectiveConfig(view.config, draft, fieldIds), [view.config, draft, fieldIds]);
  const transient = useMemo(() => toTransient(view.config, config), [view.config, config]);
  const queryConfig = useMemo(() => applyTransient(view.config, transient), [view.config, transient]);
  const layout = draftLayout(view, draft);
  const actions = useMemo(() => draftActions(role, view, draft), [role, view, draft]);

  /** What the person sees right now, read from the store so two changes in a row both count. */
  const current = useCallback(() => effectiveConfig(viewRef.current.config, readDraft(userId, viewRef.current.id), fieldIdsRef.current), [userId]);

  const commit = useCallback(
    (next: ViewConfig, to: ViewType) => {
      const v = viewRef.current;
      const prev = readDraft(userId, v.id);
      writeDraft(userId, v.id, nextDraft(prev, v, next, to, Date.now()));
    },
    [userId],
  );

  // ---- saving the form: immediate, one request at a time, the latest state last ----
  const sender = useRef<{ busy: boolean; queued: ViewConfig | null; pending: ViewConfig | null; origin: ViewConfig | null }>({ busy: false, queued: null, pending: null, origin: null });

  /** The draft started from the config before a save of our own: it starts from the one after it instead. */
  const rebase = useCallback(
    (from: ViewConfig, to: ViewConfig) => {
      const d = readDraft(userId, viewRef.current.id);
      if (d && d.base === fingerprint(from)) writeDraft(userId, viewRef.current.id, { ...d, base: fingerprint(to) });
    },
    [userId],
  );

  const pump = useCallback(async () => {
    const s = sender.current;
    if (s.busy) return;
    s.busy = true;
    setSaving(true);
    try {
      while (s.queued) {
        const sent = s.queued;
        s.queued = null;
        try {
          const saved = await api.views.update(viewRef.current.id, { config: sent });
          if (!s.queued) qc.setQueryData<BaseSchema>(keys.base(schema.id), (old) => (old ? replaceViewConfig(old, table.id, viewRef.current.id, saved?.config ?? sent) : old));
        } catch (e) {
          s.queued = null;
          toast.error(e, "Could not save the form");
          // Back to what the server has: the draft started from that, not from the form we showed.
          if (s.pending && s.origin) rebase(s.pending, s.origin);
          await qc.invalidateQueries({ queryKey: keys.base(schema.id) });
        }
      }
    } finally {
      s.pending = null;
      s.origin = null;
      s.busy = false;
      setSaving(false);
    }
  }, [qc, schema.id, table.id, toast, rebase]);

  const saveNow = useCallback(
    (mutate: (c: ViewConfig) => ViewConfig) => {
      const v = viewRef.current;
      if (!canConfigureView(role, v)) return;
      const s = sender.current;
      const before = s.pending ?? v.config;
      const next = mutate(before);
      if ([...DRAFT_KEYS, ...IMMEDIATE_KEYS].every((k) => sameSetting(k, before, next))) return;
      if (!s.pending) s.origin = v.config;
      s.pending = next;
      s.queued = next;
      rebase(before, next);
      qc.setQueryData<BaseSchema>(keys.base(schema.id), (old) => (old ? replaceViewConfig(old, table.id, v.id, next) : old));
      void pump();
    },
    [role, qc, schema.id, table.id, rebase, pump],
  );

  const update = useCallback(
    (mutate: (c: ViewConfig) => ViewConfig) => {
      const prev = current();
      const next = mutate(prev);
      // Only the settings this change touched are cleaned of deleted properties: a saved setting that was
      // already stale is not this draft's doing.
      const cleaned = sanitizeConfig(next, fieldIdsRef.current) as unknown as Record<string, unknown>;
      const candidate: Record<string, unknown> = { ...next };
      for (const key of DRAFT_KEYS) if (!sameSetting(key, prev, next)) candidate[key] = cleaned[key];
      // A form's settings are not a draft: they go to the view as they are made.
      if (!sameSetting("form", prev, next)) {
        saveNow((c) => ({ ...c, form: next.form }));
        candidate.form = prev.form;
      }
      commit(candidate as unknown as ViewConfig, readDraft(userId, viewRef.current.id)?.layout ?? viewRef.current.type);
    },
    [current, commit, saveNow, userId],
  );

  const setLayout = useCallback((type: ViewType) => commit(current(), type), [commit, current]);

  const reset = useCallback(() => writeDraft(userId, viewRef.current.id, null), [userId]);

  const updateView = useCallback(async (): Promise<boolean> => {
    const v = viewRef.current;
    const d = readDraft(userId, v.id);
    const allowed = draftActions(role, v, d);
    if (!d || !allowed.canUpdate) return false;
    const shown = current();
    const payload: Record<string, unknown> = { ...v.config };
    for (const key of allowed.updateKeys) if (key in d.changes) payload[key] = shown[key];
    setSaving(true);
    try {
      const saved = await api.views.update(v.id, { config: payload as unknown as ViewConfig });
      const savedConfig = saved?.config ?? (payload as unknown as ViewConfig);
      qc.setQueryData<BaseSchema>(keys.base(schema.id), (old) => (old ? replaceViewConfig(old, table.id, v.id, savedConfig) : old));
      // What Update view did not take (the default view's filter, sorts, groups and colors) stays a draft.
      writeDraft(userId, v.id, nextDraft({ ...d, base: fingerprint(savedConfig) }, { type: v.type, config: savedConfig }, shown, draftLayout(v, d), Date.now()));
      return true;
    } catch (e) {
      toast.error(e, "Could not update the view");
      return false;
    } finally {
      setSaving(false);
    }
  }, [userId, role, current, qc, schema.id, table.id, toast]);

  const saveAsView = useCallback(
    async ({ name, personal }: { name: string; personal: boolean }): Promise<View> => {
      const v = viewRef.current;
      const d = readDraft(userId, v.id);
      const type = draftLayout(v, d);
      // A form made from another layout starts from the server's own defaults (every editable property).
      const created = await api.views.create(table.id, { name, type, personal, config: type === "form" ? null : current() });
      await qc.invalidateQueries({ queryKey: keys.base(schema.id) });
      writeDraft(userId, v.id, null);
      return created;
    },
    [userId, current, qc, schema.id, table.id],
  );

  return {
    config,
    queryConfig,
    transient,
    layout,
    draft,
    changedOnServer: changedOnServer(draft, view.config),
    actions,
    canEditForm: canConfigure && view.type === "form",
    update,
    setLayout,
    reset,
    updateView,
    saveAsView,
    saveNow,
    saving,
  };
}

export function replaceViewConfig(schema: BaseSchema, tableId: string, viewId: string, config: ViewConfig): BaseSchema {
  return {
    ...schema,
    tables: schema.tables.map((t) => (t.id === tableId ? { ...t, views: t.views.map((v) => (v.id === viewId ? { ...v, config } : v)) } : t)),
  };
}
