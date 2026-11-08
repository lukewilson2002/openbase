import type { ComponentProps, ReactNode } from "react";
import { Tabs as T } from "radix-ui";
import { cn } from "@/lib/cn";

export const Tabs = T.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
  return (
    <T.List
      className={cn("flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none]", className)}
      {...props}
    />
  );
}

export interface TabsTriggerProps extends ComponentProps<typeof T.Trigger> {
  /** A 15 px icon before the label: on a view tab, the layout (grid, board, calendar), because it says how the data is shown. */
  icon?: ReactNode;
}

/** What makes a tab a tab, for a strip that has to measure its tabs before it draws them (the view tabs fit by width). */
export const tabTriggerClass = "-mb-px inline-flex h-control-lg shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-ui font-medium text-muted max-md:h-control-touch";

/** A text tab; the selected one is underlined in the accent (2 px) and its text is full strength. */
export function TabsTrigger({ className, icon, children, ...props }: TabsTriggerProps) {
  return (
    <T.Trigger className={cn(tabTriggerClass, "hover:text-fg data-[state=active]:border-primary data-[state=active]:text-fg", className)} {...props}>
      {icon != null && (
        <span aria-hidden className="inline-flex shrink-0 items-center [&>svg]:size-[0.9375rem]">
          {icon}
        </span>
      )}
      {children}
    </T.Trigger>
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof T.Content>) {
  return <T.Content className={cn("pt-4 focus-visible:outline-none", className)} {...props} />;
}
