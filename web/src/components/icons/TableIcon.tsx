import { Sheet } from "lucide-react";
import { cn } from "@/lib/cn";
import { EntityIcon } from "./EntityIcon";

/**
 * A table's icon: its own when it has one, else a sheet. The default is deliberately not the grid
 * view's icon, so the table never looks like one of its views in the toolbar beside them.
 */
export function TableIcon({ icon, className }: { icon?: string | null; className?: string }) {
  return icon ? <EntityIcon name={icon} className={cn("shrink-0", className)} /> : <Sheet aria-hidden className={cn("shrink-0", className)} />;
}
