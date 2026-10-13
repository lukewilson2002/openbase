/** "Download CSV" for a view: the visible fields in view order, filter and sort applied (docs/api.md §4). */
import { useState } from "react";
import { Download } from "lucide-react";
import { csvApi } from "@/api/sharing";
import type { View } from "@/api/types";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { saveBlob, safeFilename } from "@/lib/download";
import { browserTimeZone } from "@/lib/format";

export function ExportCsvButton({ view, timeZone }: { view: Pick<View, "id" | "name">; timeZone?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      // The server formats dates in this zone, so the file reads the way the grid does.
      const { blob, filename } = await csvApi.exportView(view.id, timeZone || browserTimeZone());
      saveBlob(blob, filename ?? safeFilename(`${view.name}.csv`));
    } catch (e) {
      toast.error(e, "Could not download the CSV");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="ghost" loading={busy} onClick={() => void run()} title="Download this view as a CSV file (its visible fields, filter and sort)">
      {!busy && <Download aria-hidden className="size-4" />} <span className="max-sm:sr-only">{busy ? "Preparing…" : "Download CSV"}</span>
    </Button>
  );
}
