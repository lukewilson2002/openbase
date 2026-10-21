/**
 * A base without tables (every base made with "New base" starts like this): an invitation to make
 * the first table, by name or from a CSV file. People who cannot create tables are told whom to ask.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema } from "@/api/types";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { basePermissions } from "./permissions";
import { defaultViewPath } from "@/lib/views";

export function EmptyBase({ schema, onImport }: { schema: BaseSchema; onImport: () => void }) {
  const canCreate = basePermissions.manageTables(schema.role);
  return (
    <div className="flex h-full justify-center overflow-y-auto px-4 py-10 sm:px-6 sm:py-14">
      <section aria-labelledby="empty-base-title" className="flex w-full max-w-[540px] flex-col items-center gap-[22px] text-center">
        <GridPicture />
        {canCreate ? (
          <>
            <div>
              <h2 id="empty-base-title" className="mb-2 text-[1.625rem] leading-tight tracking-[-0.015em]">
                Create your first table
              </h2>
              <p className="text-base leading-relaxed text-muted">A table is one list of things, like your chores or a shopping list. You add the fields you need as you go.</p>
            </div>
            <CreateTableForm schema={schema} />
            <p className="text-sm text-muted">
              Have a spreadsheet already?{" "}
              <button type="button" onClick={onImport} className="text-primary-text underline underline-offset-2 hover:text-primary-hover">
                Import a CSV
              </button>
            </p>
          </>
        ) : (
          <p id="empty-base-title" className="text-sm text-muted">
            This project has no tables yet. Ask someone who can create tables to add one.
          </p>
        )}
      </section>
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
      // A new table opens in its default grid, its only view.
      navigate(defaultViewPath(schema.id, table));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n && !create.isPending) create.mutate(n);
  };

  return (
    <form onSubmit={submit} aria-label="Create your first table" className="flex w-full flex-col gap-2 text-left">
      <label htmlFor="first-table-name" className="text-sm font-semibold">
        Table name
      </label>
      <div className="flex flex-wrap gap-2.5">
        <Input
          id="first-table-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="For example, Tasks"
          maxLength={255}
          autoComplete="off"
          className="h-[46px] min-w-0 flex-[1_1_240px] rounded-[10px] px-3.5 text-base"
        />
        <Button type="submit" variant="primary" size="lg" className="h-[46px] rounded-[10px] px-5 font-semibold max-[420px]:w-full" loading={create.isPending} disabled={!name.trim()}>
          Create table
        </Button>
      </div>
      {create.isError && <Notice tone="error">{errorMessage(create.error)}</Notice>}
    </form>
  );
}

// The header row tinted blue, two plain rows, and a last column with a green and a yellow pill.
const CELLS = ["head", "head", "head", "plain", "plain", "green", "plain", "plain", "yellow"] as const;
const CELL_COLOR = {
  head: "bg-[color-mix(in_srgb,var(--primary)_24%,var(--surface))]",
  plain: "bg-[color-mix(in_srgb,var(--line)_60%,var(--surface))]",
  green: "bg-success-soft",
  yellow: "bg-warning-soft",
};

/** A small table: nine cells popping in one after another, then a slow bob. */
function GridPicture() {
  return (
    <div aria-hidden className="grid w-[200px] grid-cols-3 gap-1.5 rounded-2xl border border-line bg-surface p-3.5 shadow-[0_10px_28px_rgb(15_20_30/0.08)]">
      {CELLS.map((c, i) => (
        <span key={i} className={cn("h-[18px] rounded-[5px]", CELL_COLOR[c])} />
      ))}
    </div>
  );
}
