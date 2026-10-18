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
import { basePermissions } from "./permissions";

export function TableCrumb({ schema, table }: { schema: BaseSchema; table: Table }) {
  const qc = useQueryClient();
  const toast = useToast();
  const setIcon = useMutation({
    mutationFn: (icon: string | null) => api.tables.update(table.id, { icon }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.base(schema.id) }),
    onError: (e) => toast.error(e, "Could not change the table's icon"),
  });
  return (
    <h2 className="flex min-w-0 items-center gap-1 text-base font-bold">
      {basePermissions.manageTables(schema.role) ? (
        <IconPicker value={table.icon} onChange={(icon) => setIcon.mutate(icon)} label={`Change the icon of ${table.name}`}>
          <button
            type="button"
            aria-label={`Change the icon of ${table.name}`}
            title="Change icon"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover"
          >
            <TableIcon icon={table.icon} className="size-[1.125rem]" />
          </button>
        </IconPicker>
      ) : (
        <span className="inline-flex size-8 shrink-0 items-center justify-center text-muted">
          <TableIcon icon={table.icon} className="size-[1.125rem]" />
        </span>
      )}
      <span className="min-w-0 truncate">{table.name}</span>
    </h2>
  );
}
