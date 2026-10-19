/**
 * The open table as the last part of the top bar's breadcrumb: its icon (a sheet by default; a tap
 * changes it, for those who may manage tables) and its name.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table } from "@/api/types";
import { IconPicker } from "@/components/icons/IconPicker";
import { TableIcon } from "@/components/icons/TableIcon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { basePermissions } from "./permissions";

/** Each part of the desktop path (workspace, project, table): the same type, after a 24 px tile. */
export const CRUMB_TEXT = "text-[0.875rem] font-semibold text-fg";

export function TableCrumb({ schema, table }: { schema: BaseSchema; table: Table }) {
  const qc = useQueryClient();
  const toast = useToast();
  const setIcon = useMutation({
    mutationFn: (icon: string | null) => api.tables.update(table.id, { icon }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.base(schema.id) }),
    onError: (e) => toast.error(e, "Could not change the table's icon"),
  });
  return (
    <h2 className={cn("flex min-w-0 items-center gap-2", CRUMB_TEXT)}>
      {basePermissions.manageTables(schema.role) ? (
        <IconPicker value={table.icon} onChange={(icon) => setIcon.mutate(icon)} label={`Change the icon of ${table.name}`}>
          <button
            type="button"
            aria-label={`Change the icon of ${table.name}`}
            title="Change icon"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-hover text-fg transition-colors hover:bg-line-strong data-[state=open]:bg-line-strong"
          >
            <TableIcon icon={table.icon} className="size-3.5" />
          </button>
        </IconPicker>
      ) : (
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-hover text-fg">
          <TableIcon icon={table.icon} className="size-3.5" />
        </span>
      )}
      <span className="min-w-0 truncate">{table.name}</span>
    </h2>
  );
}
