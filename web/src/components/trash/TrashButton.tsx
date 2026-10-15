import { Suspense, lazy, useState } from "react";
import { Trash2 } from "lucide-react";
import type { BaseSchema } from "@/api/types";
import { basePermissions } from "@/base/permissions";
import { SidebarButton } from "@/shell/Sidebar";

// The dialog (listing, restore, grouping) loads when the trash is first opened.
const TrashDialog = lazy(() => import("./TrashDialog").then((m) => ({ default: m.TrashDialog })));

/** The base menu's "Trash" item, opening the base's trash; renders nothing for roles that cannot see it. */
export function TrashButton({ schema }: { schema: BaseSchema }) {
  const [open, setOpen] = useState(false);
  if (!basePermissions.manageTables(schema.role)) return null;
  return (
    <>
      <SidebarButton icon={<Trash2 />} onClick={() => setOpen(true)}>
        Trash
      </SidebarButton>
      {open && (
        <Suspense fallback={null}>
          <TrashDialog open={open} onOpenChange={setOpen} schema={schema} />
        </Suspense>
      )}
    </>
  );
}
