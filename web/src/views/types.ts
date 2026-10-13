import type { ComponentType } from "react";
import type { BaseSchema, Table, View } from "@/api/types";

/** Props every view implementation receives from <ViewHost>. */
export interface ViewProps {
  schema: BaseSchema;
  table: Table;
  view: View;
  /** Caller's effective role on the base (viewer | commenter | editor | creator | owner). */
  role: string;
}

export type ViewComponent = ComponentType<ViewProps>;
