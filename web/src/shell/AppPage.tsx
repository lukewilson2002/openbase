import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { HomeShell } from "./HomeShell";

/** A page in the shell with the home menu, a title row and a centred content column (account, admin, trash). */
export function AppPage({ title, actions, children, wide }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <HomeShell>
      <div className={cn("mx-auto w-full px-4 py-6 sm:px-6", wide ? "max-w-6xl" : "max-w-4xl")}>
        {(title || actions) && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            {title && <h1 className="text-xl">{title}</h1>}
            {actions}
          </div>
        )}
        {children}
      </div>
    </HomeShell>
  );
}
