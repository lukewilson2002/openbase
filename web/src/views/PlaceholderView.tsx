import { Hammer } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { VIEW_TYPE_META } from "./meta";
import type { ViewProps } from "./types";

/** Stand-in until the real view lands (grid: W9a; the rest: W9b). */
export function PlaceholderView({ table, view }: ViewProps) {
  const meta = VIEW_TYPE_META[view.type];
  return (
    <EmptyState
      icon={<Hammer />}
      title={`${meta.label} view coming soon`}
      description={
        <>
          <strong>{view.name}</strong> will show the {table.fields.length} field{table.fields.length === 1 ? "" : "s"} of <strong>{table.name}</strong>
          {" "}as {meta.blurb.toLowerCase()}. This view type has not been built yet.
        </>
      }
      className="py-24"
    />
  );
}
