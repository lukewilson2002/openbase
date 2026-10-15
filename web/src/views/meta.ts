import { CalendarDays, ChartGantt, ClipboardList, Kanban, LayoutGrid, type LucideIcon, Rows3, Table2 } from "lucide-react";
import type { ViewType } from "@/api/types";

export interface ViewTypeMeta {
  label: string;
  icon: LucideIcon;
  defaultName: string;
  blurb: string;
  /** One plain line for the "Add view" menu. */
  description: string;
}

/** Display metadata for the seven view types (order matches `ViewType::ALL`). */
export const VIEW_TYPE_META: Record<ViewType, ViewTypeMeta> = {
  grid: { label: "Grid", icon: Table2, defaultName: "Grid view", blurb: "Spreadsheet-style rows and columns", description: "Rows and columns, like a spreadsheet" },
  form: { label: "Form", icon: ClipboardList, defaultName: "Form view", blurb: "Collect records through a form", description: "A page others fill in to add records" },
  gallery: { label: "Gallery", icon: LayoutGrid, defaultName: "Gallery view", blurb: "Records as cards with cover images", description: "Big cards with pictures" },
  kanban: { label: "Kanban", icon: Kanban, defaultName: "Kanban view", blurb: "Stacks of cards you can drag", description: "Cards in columns by a single select" },
  calendar: { label: "Calendar", icon: CalendarDays, defaultName: "Calendar view", blurb: "Records on a month or week calendar", description: "Records placed on their dates" },
  timeline: { label: "Timeline", icon: ChartGantt, defaultName: "Timeline view", blurb: "Bars on a timeline, with dependencies", description: "Start and end dates as bars" },
  list: { label: "List", icon: Rows3, defaultName: "List view", blurb: "A collapsible outline of records", description: "A simple, compact list" },
};

export const VIEW_TYPES: ViewType[] = ["grid", "form", "gallery", "kanban", "calendar", "timeline", "list"];
