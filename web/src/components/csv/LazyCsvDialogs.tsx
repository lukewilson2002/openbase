import { Suspense, lazy, type ComponentProps } from "react";

// The CSV import dialogs (file picker, preview, column mapping) load on first use.
const Import = lazy(() => import("./ImportCsvDialog").then((m) => ({ default: m.ImportCsvDialog })));
const NewTable = lazy(() => import("./NewTableFromCsvDialog").then((m) => ({ default: m.NewTableFromCsvDialog })));

/** `ImportCsvDialog`, loaded on first use. Render it only while it is wanted. */
export function ImportCsvDialog(props: ComponentProps<typeof Import>) {
  return (
    <Suspense fallback={null}>
      <Import {...props} />
    </Suspense>
  );
}

/** `NewTableFromCsvDialog`, loaded on first use. Render it only while it is wanted. */
export function NewTableFromCsvDialog(props: ComponentProps<typeof NewTable>) {
  return (
    <Suspense fallback={null}>
      <NewTable {...props} />
    </Suspense>
  );
}
