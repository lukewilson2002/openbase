/**
 * A folder without collections (a new folder starts like this): an invitation to make the first one, or to
 * import a CSV file as it. People who cannot create collections are told whom to ask.
 */
import type { BaseSchema } from "@/api/types";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { basePermissions } from "./permissions";

export function EmptyBase({ schema, onNew, onImport }: { schema: BaseSchema; onNew: () => void; onImport: () => void }) {
  const canCreate = basePermissions.manageTables(schema.role);
  return (
    <div className="flex h-full flex-col justify-center overflow-y-auto">
      {canCreate ? (
        <EmptyState
          title={`No collections in ${schema.name} yet`}
          description="A collection is one list of things, like your chores or a shopping list. You add the properties you need as you go."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={onNew}>
                New collection
              </Button>
              <Button onClick={onImport}>Import CSV</Button>
            </div>
          }
        />
      ) : (
        <EmptyState title={`No collections in ${schema.name} yet`} description="Ask someone who can create collections to add one." />
      )}
    </div>
  );
}
