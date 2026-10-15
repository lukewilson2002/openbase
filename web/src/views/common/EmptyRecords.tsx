import { Plus } from "lucide-react";

/**
 * What a list or gallery shows with nothing in it: one message with room around it, and a quiet
 * Add for people who can add. Searching says so, and offers no Add, since a new record would not
 * match the search and would seem to vanish.
 */
export function EmptyRecords({ searching, onAdd }: { searching: boolean; onAdd?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <p className="text-[0.875rem] text-muted">{searching ? "No records match your search." : "No records yet."}</p>
      {onAdd && !searching && (
        <button
          type="button"
          onClick={onAdd}
          className="flex h-9 items-center gap-1.5 rounded-md px-3 text-[0.875rem] text-muted hover:bg-hover hover:text-fg pointer-coarse:h-11"
        >
          <Plus aria-hidden className="size-[15px]" /> Add
        </button>
      )}
    </div>
  );
}
