/**
 * "Use as title" and "Use as page" (FLD-3, FLD-4): the calls Collection settings makes, from a property's own
 * menu. They are `POST /api/tables/{id}/primary-field` and `POST /api/tables/{id}/body-field` (MCP
 * `set_primary_field` and `set_page_field`), so an agent can do the same.
 */
import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { Field, Table } from "@/api/types";
import { useToast } from "@/components/ui/toast";

export interface PropertyRoles {
  /** Makes the property the collection's title. */
  setTitle(field: Field): void;
  /** Makes the rich text property the collection's page. */
  setPage(field: Field): void;
}

export function usePropertyRoles(baseId: string, table: Pick<Table, "id">): PropertyRoles {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useCallback(() => Promise.all([qc.invalidateQueries({ queryKey: keys.base(baseId) }), qc.invalidateQueries({ queryKey: keys.workspaces }), qc.invalidateQueries({ queryKey: ["records"] })]), [qc, baseId]);

  const title = useMutation({
    mutationFn: (field: Field) => api.tables.setPrimaryField(table.id, field.id),
    onSuccess: async (_, field) => {
      await refresh();
      toast.toast({ title: `“${field.name}” is now the title`, variant: "success" });
    },
    onError: (e) => toast.error(e, "Could not change the title property"),
  });
  const page = useMutation({
    mutationFn: (field: Field) => api.tables.setBodyField(table.id, { field_id: field.id }),
    onSuccess: async (_, field) => {
      await refresh();
      toast.toast({ title: `“${field.name}” is now the page`, variant: "success" });
    },
    onError: (e) => toast.error(e, "Could not change the page property"),
  });

  return { setTitle: title.mutate, setPage: page.mutate };
}
