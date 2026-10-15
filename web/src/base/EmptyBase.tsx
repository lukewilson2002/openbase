/**
 * A base without tables (every base made with "New base" starts like this): an invitation to make
 * the first table, by name or from a CSV file. People who cannot create tables are told whom to ask.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema } from "@/api/types";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { basePermissions } from "./permissions";
import "./emptyBase.css";

export function EmptyBase({ schema, onImport }: { schema: BaseSchema; onImport: () => void }) {
  const canCreate = basePermissions.manageTables(schema.role);
  return (
    <div className="flex h-full overflow-y-auto">
      <div className="m-auto flex w-full max-w-md flex-col items-center px-4 py-10 text-center">
        <GridPicture />
        {canCreate ? (
          <>
            <h2 className="mt-6 text-lg">Create your first table</h2>
            <p className="mt-2 text-[0.8125rem] text-muted">A table is one list of things, like your chores or a shopping list. You add the fields you need as you go.</p>
            <CreateTableForm schema={schema} />
            <p className="mt-5 text-[0.8125rem] text-muted">
              Have a spreadsheet already?{" "}
              <button type="button" onClick={onImport} className="font-medium text-primary underline-offset-2 hover:underline">
                Import a CSV
              </button>
            </p>
          </>
        ) : (
          <p className="mt-6 text-[0.8125rem] text-muted">This base has no tables yet. Ask someone who can create tables to add one.</p>
        )}
      </div>
    </div>
  );
}

function CreateTableForm({ schema }: { schema: BaseSchema }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (n: string) => api.tables.create(schema.id, n, null),
    onSuccess: async (table) => {
      await qc.invalidateQueries({ queryKey: keys.base(schema.id) });
      const view = table.views?.[0];
      navigate(`/base/${schema.id}/${table.id}${view ? `/${view.id}` : ""}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n && !create.isPending) create.mutate(n);
  };

  return (
    <form onSubmit={submit} aria-label="Create your first table" className="mt-6 flex w-full flex-col gap-2 text-left">
      <label htmlFor="first-table-name" className="text-[0.8125rem] font-medium">
        Table name
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input id="first-table-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Chores" maxLength={255} autoComplete="off" className="sm:flex-1" />
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
          <Plus aria-hidden className="size-4" /> Create table
        </Button>
      </div>
      {create.isError && <Notice tone="error">{errorMessage(create.error)}</Notice>}
    </form>
  );
}

/** Nine cells popping in one after another, the top row darker like a header; then a slow bob. */
function GridPicture() {
  return (
    <div aria-hidden className="ob-empty-bob grid grid-cols-3 gap-1.5 rounded-xl border border-line bg-surface p-2.5 shadow-pop">
      {Array.from({ length: 9 }, (_, i) => (
        <span
          key={i}
          className={cn("ob-empty-cell h-5 w-9 rounded", i < 3 ? "bg-primary" : "border border-primary/25 bg-primary-soft")}
          style={{ animationDelay: `${120 + i * 70}ms` }}
        />
      ))}
    </div>
  );
}
