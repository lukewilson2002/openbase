import { lazy } from "react";
import type { ViewType } from "@/api/types";
import { PlaceholderView } from "./PlaceholderView";
import type { ViewComponent } from "./types";

/**
 * Which component renders each view type inside <ViewHost>.
 *
 * Later workstreams replace their placeholder line with the real component
 * (use `lazy(() => import("./grid/GridView"))` to keep the shell bundle small;
 * <ViewHost> wraps views in Suspense and an error boundary). One entry per line
 * so parallel workstreams touch different lines.
 */
export const viewRegistry: Record<ViewType, ViewComponent> = {
  grid: lazy(() => import("./grid/GridView")), // W9a
  form: lazy(() => import("./form/FormView")), // W9c
  gallery: lazy(() => import("./gallery/GalleryView")), // W9b
  kanban: lazy(() => import("./kanban/KanbanView")), // W9b
  calendar: lazy(() => import("./calendar/CalendarView")), // W9b
  timeline: lazy(() => import("./timeline/TimelineView")), // W9b
  list: lazy(() => import("./list/ListView")), // W9b
};

export function getViewComponent(type: ViewType): ViewComponent {
  return viewRegistry[type] ?? PlaceholderView;
}
