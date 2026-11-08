/**
 * A view's draft (COL-5): the changes one person has made to a view on this device and not saved. Pure
 * functions only; where drafts are kept is `store.ts`, who may save them is `permissions.ts`.
 *
 * A draft holds the full new value of each setting that differs from the saved view, not a patch inside
 * it, so applying it is a spread over the saved config and reverting a setting by hand removes it again.
 */
import type { Filter, RowColor, RowHeight, TransientConfig, ViewConfig, ViewType } from "@/api/types";
import { VIEW_TYPES } from "@/views/meta";
import { DRAFT_KEYS, QUERY_KEYS } from "./classify";

export const DRAFT_VERSION = 1;

export interface ViewDraft {
  v: typeof DRAFT_VERSION;
  /**
   * A fingerprint of the saved config the draft started from, to tell when the view changed on the
   * server meanwhile. Null for a draft moved over from the old local storage: it takes the fingerprint of
   * the view the first time it meets it.
   */
  base: string | null;
  /** When the draft started (ms since the epoch). */
  started: number;
  /** The layout being shown, when it is not the view's own. */
  layout?: ViewType;
  /** The draft settings that differ from the saved view, each with its whole new value. */
  changes: Partial<ViewConfig>;
}

const EMPTY_FILTER: Filter = { conjunction: "and", items: [] };
/** What a transient sends to drop the saved row colors (TransientConfig has no other way to say "none"). */
const NO_ROW_COLOR: RowColor = { mode: "by_conditions", rules: [] };

/** JSON with the keys of every object in order, so equal settings compare equal however they were built. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A setting as it is compared: "no filter", "no row colors" and "unset" are each one thing. */
function canonical(key: keyof ViewConfig, value: unknown): unknown {
  if (key === "filter") {
    const f = value as Filter | null | undefined;
    return f && f.items.length > 0 ? f : null;
  }
  if (key === "row_color") {
    const rc = value as RowColor | null | undefined;
    return !rc || isNoRowColor(rc) ? null : rc;
  }
  return value ?? null;
}

function isNoRowColor(rc: RowColor): boolean {
  return rc.mode === "by_conditions" && rc.rules.length === 0;
}

/** Whether two configs hold the same value for `key`. */
export function sameSetting(key: keyof ViewConfig, a: ViewConfig, b: ViewConfig): boolean {
  return stable(canonical(key, a[key])) === stable(canonical(key, b[key]));
}

/** Short stable hash (FNV-1a) of a saved config. */
export function fingerprint(config: ViewConfig): string {
  const text = stable(config);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The draft settings in which `next` differs from `saved`. */
export function diffChanges(saved: ViewConfig, next: ViewConfig): Partial<ViewConfig> {
  const changes: Record<string, unknown> = {};
  for (const key of DRAFT_KEYS) {
    if (!sameSetting(key, saved, next)) changes[key] = canonical(key, next[key]);
  }
  return changes as Partial<ViewConfig>;
}

/** The saved config with the draft's settings laid over it: what the person sees. */
export function applyDraft(saved: ViewConfig, draft: Pick<ViewDraft, "changes"> | null): ViewConfig {
  return draft ? { ...saved, ...draft.changes } : saved;
}

/**
 * The query settings of `effective` that differ from `saved`, as the override sent with each query so the
 * server computes them. Null when the draft leaves the query alone.
 */
export function toTransient(saved: ViewConfig, effective: ViewConfig): TransientConfig | null {
  const t: TransientConfig = {};
  for (const key of QUERY_KEYS) {
    if (sameSetting(key, saved, effective)) continue;
    switch (key) {
      case "filter":
        // "No filter" is a filter without items: leaving the part out would keep the saved one.
        t.filter = effective.filter && effective.filter.items.length > 0 ? effective.filter : EMPTY_FILTER;
        break;
      case "sorts":
        t.sorts = effective.sorts;
        break;
      case "groups":
        t.groups = effective.groups;
        break;
      case "row_color":
        t.row_color = effective.row_color && !isNoRowColor(effective.row_color) ? effective.row_color : NO_ROW_COLOR;
        break;
      case "summaries":
        t.summaries = effective.summaries;
        break;
    }
  }
  return Object.keys(t).length > 0 ? t : null;
}

/** The config the server runs for a query carrying `transient`. */
export function applyTransient(saved: ViewConfig, transient: TransientConfig | null): ViewConfig {
  if (!transient) return saved;
  return {
    ...saved,
    filter: transient.filter ? (transient.filter.items.length > 0 ? transient.filter : null) : saved.filter,
    sorts: transient.sorts ?? saved.sorts,
    groups: transient.groups ?? saved.groups,
    row_color: transient.row_color ? (isNoRowColor(transient.row_color) ? null : transient.row_color) : saved.row_color,
    summaries: transient.summaries ?? saved.summaries,
  };
}

/** Whether the draft changes any of `keys`. */
export function touches(draft: Pick<ViewDraft, "changes"> | null, keys: readonly (keyof ViewConfig)[]): boolean {
  return !!draft && keys.some((k) => k in draft.changes);
}

/**
 * The draft after a change: `effective` and `layout` are what the person now sees, compared with the
 * saved view. Null when nothing differs any more, so a draft undone by hand disappears. It keeps its start
 * and the config it started from.
 */
export function nextDraft(prev: ViewDraft | null, saved: { type: ViewType; config: ViewConfig }, effective: ViewConfig, layout: ViewType, now: number): ViewDraft | null {
  const changes = diffChanges(saved.config, effective);
  const layoutDraft = layout !== saved.type ? layout : undefined;
  if (Object.keys(changes).length === 0 && !layoutDraft) return null;
  return {
    v: DRAFT_VERSION,
    base: prev?.base ?? fingerprint(saved.config),
    started: prev?.started ?? now,
    ...(layoutDraft ? { layout: layoutDraft } : {}),
    changes,
  };
}

/** Whether the view was saved with another config than the one the draft started from. */
export function changedOnServer(draft: ViewDraft | null, savedConfig: ViewConfig): boolean {
  return !!draft && draft.base !== null && draft.base !== fingerprint(savedConfig);
}

// ---- reading what is stored ----

const ROW_HEIGHTS: readonly RowHeight[] = ["short", "medium", "tall", "extra_tall"];
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Whether a stored value can stand for the setting `key` (storage can hold anything an older version or a person put there). */
function plausible(key: keyof ViewConfig, v: unknown): boolean {
  switch (key) {
    case "filter":
      return v === null || (isObject(v) && Array.isArray(v.items));
    case "row_color":
      return v === null || (isObject(v) && (v.mode === "by_select" || v.mode === "by_conditions"));
    case "sorts":
    case "groups":
    case "hidden_fields":
    case "field_order":
      return Array.isArray(v);
    case "field_widths":
    case "summaries":
    case "kanban":
    case "calendar":
    case "gallery":
    case "list":
    case "timeline":
      return isObject(v);
    case "frozen_columns":
      return typeof v === "number" && Number.isFinite(v) && v >= 0;
    case "row_height":
      return typeof v === "string" && (ROW_HEIGHTS as readonly string[]).includes(v);
    case "wrap_headers":
      return typeof v === "boolean";
    case "description_field_id":
      return v === null || typeof v === "string";
    default:
      return false;
  }
}

/** A draft from parsed JSON, or null when it is not one. Settings that make no sense are dropped, not the draft. */
export function parseDraft(value: unknown): ViewDraft | null {
  if (!isObject(value) || value.v !== DRAFT_VERSION || !isObject(value.changes)) return null;
  const changes: Record<string, unknown> = {};
  for (const key of DRAFT_KEYS) {
    if (key in value.changes && plausible(key, value.changes[key])) changes[key] = value.changes[key];
  }
  const layout = typeof value.layout === "string" && (VIEW_TYPES as string[]).includes(value.layout) ? (value.layout as ViewType) : undefined;
  if (Object.keys(changes).length === 0 && !layout) return null;
  return {
    v: DRAFT_VERSION,
    base: typeof value.base === "string" ? value.base : null,
    started: typeof value.started === "number" ? value.started : 0,
    ...(layout ? { layout } : {}),
    changes: changes as Partial<ViewConfig>,
  };
}
