/**
 * Which `ViewConfig` settings are a draft and which save as they are made (decision 4, COL-5).
 *
 * Every key of the config is classified here, and the table is typed as `Record<keyof ViewConfig, ...>`,
 * so a new setting cannot be added to the config without deciding which one it is.
 */
import type { ViewConfig } from "@/api/types";

/**
 * - `query`: filter, sorts, groups, row colors and summaries. The server computes them, so a draft
 *   sends them as the request's `TransientConfig` (BE-12).
 * - `layout`: how the properties sit (order, hidden, widths, frozen, row height, wrapped headers).
 *   On the default view these are the only settings Update view saves.
 * - `cards`: the description property that cards, events and bars read.
 * - `layout-settings`: the board, calendar, gallery, timeline and list settings.
 * - `form`: a form's own settings and fields. A public form follows the live form, so they save at once.
 */
export type SettingGroup = "query" | "layout" | "cards" | "layout-settings" | "form";

export interface SettingClass {
  mode: "draft" | "immediate";
  group: SettingGroup;
}

const draft = (group: Exclude<SettingGroup, "form">): SettingClass => ({ mode: "draft", group });

export const SETTING_CLASS: Record<keyof ViewConfig, SettingClass> = {
  filter: draft("query"),
  sorts: draft("query"),
  groups: draft("query"),
  row_color: draft("query"),
  summaries: draft("query"),
  hidden_fields: draft("layout"),
  field_order: draft("layout"),
  field_widths: draft("layout"),
  frozen_columns: draft("layout"),
  row_height: draft("layout"),
  wrap_headers: draft("layout"),
  description_field_id: draft("cards"),
  kanban: draft("layout-settings"),
  calendar: draft("layout-settings"),
  gallery: draft("layout-settings"),
  list: draft("layout-settings"),
  timeline: draft("layout-settings"),
  form: { mode: "immediate", group: "form" },
};

const keysOf = (pick: (c: SettingClass) => boolean): (keyof ViewConfig)[] => (Object.keys(SETTING_CLASS) as (keyof ViewConfig)[]).filter((k) => pick(SETTING_CLASS[k]));

/** Every setting a draft can hold. */
export const DRAFT_KEYS = keysOf((c) => c.mode === "draft");
/** The settings that save as they are made. */
export const IMMEDIATE_KEYS = keysOf((c) => c.mode === "immediate");
/** The settings a draft sends to the server with each query. */
export const QUERY_KEYS = keysOf((c) => c.group === "query");
/** The settings Update view saves on the default view, which sets the layout of every record. */
export const LAYOUT_KEYS = keysOf((c) => c.group === "layout");
