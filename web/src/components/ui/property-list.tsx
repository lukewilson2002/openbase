import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** The label column is 160 px wide, 116 on phone; rows are 36 px, 44 on phone. */
const ROW = "grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-x-3 min-h-9 max-md:grid-cols-[7.25rem_minmax(0,1fr)] max-md:min-h-control-touch";

/** A record's properties as label and value rows. Put `PropertyRow`s inside. */
export function PropertyList({ className, ...props }: ComponentProps<"dl">) {
  return <dl className={cn("m-0 flex flex-col", className)} {...props} />;
}

export interface PropertyRowProps extends Omit<ComponentProps<"div">, "children" | "title"> {
  label: ReactNode;
  /** The value, or its editor. */
  children: ReactNode;
}

export function PropertyRow({ label, children, className, ...props }: PropertyRowProps) {
  return (
    <div className={cn(ROW, className)} {...props}>
      <dt className="truncate text-label text-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-ui">{children}</dd>
    </div>
  );
}
