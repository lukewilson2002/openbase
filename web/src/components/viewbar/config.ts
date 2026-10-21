/**
 * Pure mutations of a view's `ViewConfig`. Every function returns a new config and never
 * mutates its input; the toolbar persists the result with `PATCH /api/views/{id}`
 * (a full replacement of the config).
 */
import type { Aggregation, Direction, Field, Filter, Group, RowColor, RowHeight, Table, ViewConfig } from "@/api/types";
import { kindClassOf } from "@/lib/cells/kinds";
import { countConditions, MAX_FILTER_CONDITIONS, newCondition, pruneFilter } from "@/lib/cells/filters";

export const MAX_SORTS = 10;
export const MAX_GROUPS = 3;

/** Fields can be grouped and sorted unless they are inert (buttons). */
export function isSortable(field: Field): boolean {
  return kindClassOf(field) !== "inert";
}

export function isGroupable(field: Field): boolean {
  const k = kindClassOf(field);
  return k !== "inert" && k !== "attachment";
}

/**
 * Display order: the primary field first, then `field_order` (unknown ids skipped), then the
 * remaining fields in table order. Hidden fields are excluded from `visible` and returned in
 * `hidden` (in the same order).
 */
export function resolveFieldOrder(table: Pick<Table, "fields" | "primary_field_id">, config: Pick<ViewConfig, "field_order" | "hidden_fields">): { visible: Field[]; hidden: Field[]; all: Field[] } {
  const byId = new Map(table.fields.map((f) => [f.id, f] as const));
  const seen = new Set<string>();
  const all: Field[] = [];
  const push = (id: string) => {
    const f = byId.get(id);
    if (f && !seen.has(id)) {
      seen.add(id);
      all.push(f);
    }
  };
  push(table.primary_field_id);
  for (const id of config.field_order) push(id);
  for (const f of table.fields) push(f.id);
  const hiddenSet = new Set(config.hidden_fields);
  const visible: Field[] = [];
  const hidden: Field[] = [];
  for (const f of all) {
    // The primary field cannot be hidden.
    if (f.id !== table.primary_field_id && hiddenSet.has(f.id)) hidden.push(f);
    else visible.push(f);
  }
  return { visible, hidden, all };
}

export function setHiddenField(config: ViewConfig, table: Pick<Table, "fields" | "primary_field_id">, fieldId: string, hidden: boolean): ViewConfig {
  if (fieldId === table.primary_field_id) return config;
  const rest = config.hidden_fields.filter((id) => id !== fieldId);
  return { ...config, hidden_fields: hidden ? [...rest, fieldId] : rest };
}

export function setAllHidden(config: ViewConfig, table: Pick<Table, "fields" | "primary_field_id">, hidden: boolean): ViewConfig {
  return { ...config, hidden_fields: hidden ? table.fields.filter((f) => f.id !== table.primary_field_id).map((f) => f.id) : [] };
}

/** Move the field at `from` to `to` among all fields (indexes into `resolveFieldOrder(...).all`). */
export function moveField(config: ViewConfig, table: Pick<Table, "fields" | "primary_field_id">, fromId: string, toId: string): ViewConfig {
  if (fromId === table.primary_field_id || toId === table.primary_field_id) return config;
  const ids = resolveFieldOrder(table, config).all.map((f) => f.id);
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return config;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, fromId);
  return { ...config, field_order: next };
}

/** Reorder using the visible column order after a drag (hidden fields keep their relative slots at the end). */
export function reorderVisible(config: ViewConfig, table: Pick<Table, "fields" | "primary_field_id">, orderedVisibleIds: readonly string[]): ViewConfig {
  const { hidden } = resolveFieldOrder(table, config);
  return { ...config, field_order: [...orderedVisibleIds, ...hidden.map((f) => f.id)] };
}

export function setFieldWidth(config: ViewConfig, fieldId: string, width: number): ViewConfig {
  return { ...config, field_widths: { ...config.field_widths, [fieldId]: Math.max(40, Math.round(width)) } };
}

export function setFrozenColumns(config: ViewConfig, n: number): ViewConfig {
  return { ...config, frozen_columns: Math.max(0, Math.floor(n)) };
}

export function setRowHeight(config: ViewConfig, h: RowHeight): ViewConfig {
  return { ...config, row_height: h };
}

export function setSummary(config: ViewConfig, fieldId: string, agg: Aggregation): ViewConfig {
  const summaries = { ...config.summaries };
  if (agg === "none") delete summaries[fieldId];
  else summaries[fieldId] = agg;
  return { ...config, summaries };
}

/** Append a condition on `field` to the top level of the view filter ("Filter by this field"). */
export function addFilterCondition(config: ViewConfig, field: Field): ViewConfig {
  if (countConditions(config.filter) >= MAX_FILTER_CONDITIONS) return config;
  const current: Filter = config.filter ?? { conjunction: "and", items: [] };
  return { ...config, filter: { ...current, items: [...current.items, newCondition(field)] } };
}

export function setFilter(config: ViewConfig, filter: Filter | null): ViewConfig {
  return { ...config, filter: filter && filter.items.length > 0 ? filter : null };
}

// ---- sorts and groups share one shape -----------------------------------------------------

type SortKey = "sorts" | "groups";
const LIMITS: Record<SortKey, number> = { sorts: MAX_SORTS, groups: MAX_GROUPS };

export function addSortLike(config: ViewConfig, key: SortKey, fieldId: string, direction: Direction = "asc"): ViewConfig {
  const list = config[key];
  if (list.length >= LIMITS[key] || list.some((s) => s.field_id === fieldId)) return config;
  return { ...config, [key]: [...list, { field_id: fieldId, direction }] };
}

/**
 * Patch one sort or group level. A group's granularity belongs to its field (only dates have
 * one), so picking another field drops it and the level starts again at the default, by day.
 */
export function updateSortLike(config: ViewConfig, key: SortKey, index: number, patch: Partial<Group>): ViewConfig {
  const list: readonly Group[] = config[key];
  if (index < 0 || index >= list.length) return config;
  // Changing the field to one already used elsewhere would duplicate it.
  if (patch.field_id && list.some((s, i) => i !== index && s.field_id === patch.field_id)) return config;
  const next = (s: Group): Group => {
    const merged = { ...s, ...patch };
    if (patch.field_id === undefined || patch.field_id === s.field_id || "granularity" in patch) return merged;
    const { granularity: _dropped, ...rest } = merged;
    return rest;
  };
  return { ...config, [key]: list.map((s, i) => (i === index ? next(s) : s)) };
}

export function removeSortLike(config: ViewConfig, key: SortKey, index: number): ViewConfig {
  return { ...config, [key]: config[key].filter((_, i) => i !== index) };
}

export function moveSortLike(config: ViewConfig, key: SortKey, from: number, to: number): ViewConfig {
  const list = [...config[key]];
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return config;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item!);
  return { ...config, [key]: list };
}

/** "Sort by this field" from a column menu: replaces all sorts with a single one. */
export function sortOnly(config: ViewConfig, fieldId: string, direction: Direction): ViewConfig {
  return { ...config, sorts: [{ field_id: fieldId, direction }] };
}

export function setRowColor(config: ViewConfig, rowColor: RowColor | null): ViewConfig {
  return { ...config, row_color: rowColor };
}

/**
 * Remove references to fields that no longer exist so the server never rejects a stale config
 * (filters, sorts, groups, hidden/ordered fields, widths, summaries, row colours).
 */
export function sanitizeConfig(config: ViewConfig, fieldIds: ReadonlySet<string>): ViewConfig {
  const has = (id: string) => fieldIds.has(id);
  const filter = config.filter ? pruneFilter(config.filter, fieldIds) : null;
  let rowColor = config.row_color ?? null;
  if (rowColor?.mode === "by_select" && !has(rowColor.field_id)) rowColor = null;
  if (rowColor?.mode === "by_conditions") {
    rowColor = { ...rowColor, rules: rowColor.rules.map((r) => ({ ...r, filter: pruneFilter(r.filter, fieldIds) })) };
  }
  return {
    ...config,
    filter: filter && filter.items.length > 0 ? filter : null,
    sorts: config.sorts.filter((s) => has(s.field_id)),
    groups: config.groups.filter((s) => has(s.field_id)),
    hidden_fields: config.hidden_fields.filter(has),
    field_order: config.field_order.filter(has),
    field_widths: Object.fromEntries(Object.entries(config.field_widths).filter(([id]) => has(id))),
    summaries: Object.fromEntries(Object.entries(config.summaries).filter(([id]) => has(id))),
    row_color: rowColor,
  };
}

/** Whether two configs differ in anything the record query depends on (not just widths/order). */
export function queryRelevantKey(config: ViewConfig): string {
  return JSON.stringify([config.filter ?? null, config.sorts, config.groups, config.row_color ?? null, config.hidden_fields]);
}

export const ROW_HEIGHT_LABELS: Record<RowHeight, string> = {
  short: "Short",
  medium: "Medium",
  tall: "Tall",
  extra_tall: "Extra tall",
};

/** Pixel heights per row-height setting. */
export const ROW_HEIGHT_PX: Record<RowHeight, number> = {
  short: 42,
  medium: 56,
  tall: 88,
  extra_tall: 128,
};
