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
  grid: PlaceholderView, // W9a
  form: PlaceholderView, // W9b
  gallery: PlaceholderView, // W9b
  kanban: PlaceholderView, // W9b
  calendar: PlaceholderView, // W9b
  timeline: PlaceholderView, // W9b
  list: PlaceholderView, // W9b
};

export function getViewComponent(type: ViewType): ViewComponent {
  return viewRegistry[type] ?? PlaceholderView;
}
