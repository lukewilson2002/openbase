import { Suspense, lazy, type ComponentProps } from "react";

// Members, roles and invites load when the dialog is first opened.
const Impl = lazy(() => import("./SharingDialog").then((m) => ({ default: m.SharingDialog })));

/** `SharingDialog`, loaded on first use. Render it only while it is wanted. */
export function SharingDialog(props: ComponentProps<typeof Impl>) {
  return (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  );
}
