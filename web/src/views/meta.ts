import { CalendarDays, ChartGantt, ClipboardList, Kanban, LayoutGrid, type LucideIcon, Rows3, Table2 } from "lucide-react";
import type { ViewType } from "@/api/types";

export interface ViewTypeMeta {
  label: string;
  icon: LucideIcon;
  defaultName: string;
  blurb: string;
}

/** Display metadata for the seven view types (order matches `ViewType::ALL`). */
export const VIEW_TYPE_META: Record<ViewType, ViewTypeMeta> = {
  grid: { label: "Grid", icon: Table2, defaultName: "Grid view", blurb: "Spreadsheet-style rows and columns" },
  form: { label: "Form", icon: ClipboardList, defaultName: "Form view", blurb: "Collect records through a form" },
  gallery: { label: "Gallery", icon: LayoutGrid, defaultName: "Gallery view", blurb: "Records as cards with cover images" },
  kanban: { label: "Kanban", icon: Kanban, defaultName: "Kanban view", blurb: "Stacks of cards you can drag" },
  calendar: { label: "Calendar", icon: CalendarDays, defaultName: "Calendar view", blurb: "Records on a month or week calendar" },
  timeline: { label: "Timeline", icon: ChartGantt, defaultName: "Timeline view", blurb: "Bars on a timeline, with dependencies" },
  list: { label: "List", icon: Rows3, defaultName: "List view", blurb: "A collapsible outline of records" },
};

export const VIEW_TYPES: ViewType[] = ["grid", "form", "gallery", "kanban", "calendar", "timeline", "list"];
