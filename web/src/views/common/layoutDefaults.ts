import type { Field, ViewConfig, ViewType } from "@/api/types";
import { isStackField, likelyStackField } from "../kanban/stacks";
import { isDateLike, likelyDateField } from "./wallTime";

/**
 * The config a layout starts with when a person switches to it from View options: a board stacks by the property it
 * most likely wants and a calendar places records by the date it most likely wants, so one tap on the tile shows the
 * layout (guess, then let people correct: the board's and the calendar's own settings change the guess). A collection
 * with no such property keeps the layout's setup screen, which says what to add. A setting already made is left alone.
 */
export function withLayoutDefaults(config: ViewConfig, type: ViewType, fields: readonly Field[]): ViewConfig {
  if (type === "kanban") {
    const stackable = fields.filter(isStackField);
    if (stackable.some((f) => f.id === config.kanban.stack_field_id)) return config;
    const likely = likelyStackField(stackable);
    return likely ? { ...config, kanban: { ...config.kanban, stack_field_id: likely.id, stack_order: [], hidden_stacks: [] } } : config;
  }
  if (type === "calendar") {
    const dates = fields.filter(isDateLike);
    if (dates.some((f) => f.id === config.calendar.date_field_id)) return config;
    const likely = likelyDateField(dates);
    return likely ? { ...config, calendar: { ...config.calendar, date_field_id: likely.id } } : config;
  }
  return config;
}
