import { Suspense, lazy, useState } from "react";
import { Trash2 } from "lucide-react";
import type { BaseSchema } from "@/api/types";
import { basePermissions } from "@/base/permissions";
import { IconButton } from "@/components/ui/icon-button";

// The dialog (listing, restore, grouping) loads when the trash is first opened.
const TrashDialog = lazy(() => import("./TrashDialog").then((m) => ({ default: m.TrashDialog })));

/** Toolbar button that opens the trash; renders nothing for roles that cannot see it. */
export function TrashButton({ schema }: { schema: BaseSchema }) {
  const [open, setOpen] = useState(false);
  if (!basePermissions.manageTables(schema.role)) return null;
  return (
    <>
      <IconButton label="Trash" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden className="size-4" />
      </IconButton>
      {open && (
        <Suspense fallback={null}>
          <TrashDialog open={open} onOpenChange={setOpen} schema={schema} />
        </Suspense>
      )}
    </>
  );
}
