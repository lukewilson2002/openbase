import type { ReactNode } from "react";
import { Tooltip as T } from "radix-ui";

/** Hover/focus tooltip around a single focusable child. */
export function Tooltip({ content, children, side = "bottom" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Provider delayDuration={300} skipDelayDuration={100}>
      <T.Root>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          <T.Content
            side={side}
            sideOffset={6}
            className="ob-fade-in z-[60] max-w-xs rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-pop"
          >
            {content}
            <T.Arrow className="fill-fg" />
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
