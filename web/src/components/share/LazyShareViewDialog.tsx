import { Suspense, lazy } from "react";
import type { ShareViewDialogProps } from "./ShareViewDialog";

// The dialog (links, passwords, what is public) is only needed once someone clicks "Share view".
const Impl = lazy(() => import("./ShareViewDialog").then((m) => ({ default: m.ShareViewDialog })));

/** `ShareViewDialog`, loaded on first use. Render it only while it is wanted. */
export function ShareViewDialog(props: ShareViewDialogProps) {
  return (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  );
}
