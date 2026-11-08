import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { HomeShell } from "./HomeShell";

/** A screen in the shell with the home menu, its title in the header and a centred content column (account, admin). */
export function AppPage({ title, actions, children, wide }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <HomeShell title={title} actions={actions}>
      <div className={cn("mx-auto w-full px-4 py-6 sm:px-6", wide ? "max-w-6xl" : "max-w-4xl")}>{children}</div>
    </HomeShell>
  );
}
