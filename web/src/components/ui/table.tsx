import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { Card } from "./card";

export interface TableProps extends ComponentProps<"table"> {
  /** Narrower than this and the table scrolls sideways inside its own box (PH-7) rather than squeezing its columns. */
  minWidth?: string;
  /** Names the box that scrolls sideways, which takes the keyboard focus so its overflow can be reached without a mouse. */
  label: string;
}

/**
 * The shared table styles (APP-15): a bordered Card that scrolls sideways on its own, a quiet header row, and
 * 46 px body rows. Admin's Users and Audit tables are built from these, so every table looks alike.
 */
export function Table({ className, minWidth, style, label, ...props }: TableProps) {
  return (
    <Card padded={false} className="overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
      <table className={cn("w-full text-left text-ui", className)} style={{ minWidth, ...style }} {...props} />
    </Card>
  );
}

export function THead({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("border-b border-line bg-subtle text-label text-muted", className)} {...props} />;
}

/** A column header: always `scope="col"`, so assistive technology reads each cell with its column. */
export function Th({ className, scope = "col", ...props }: ComponentProps<"th">) {
  return <th scope={scope} className={cn("px-3 py-2 text-left font-medium", className)} {...props} />;
}

export function TBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("divide-y divide-line", className)} {...props} />;
}

export function Tr({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("h-row-table", className)} {...props} />;
}

export function Td({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-3 py-2", className)} {...props} />;
}
