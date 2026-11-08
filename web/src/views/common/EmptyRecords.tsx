import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { newRecordLabel, pluralize, recordNoun } from "@/lib/recordNoun";

export interface EmptyRecordsProps {
  /** The collection, for what it calls its records ("clients"). */
  table: { record_noun?: string | null };
  /** The view's filter or search is why nothing shows. */
  filtered: boolean;
  /** Adds a record; omitted for people who cannot. */
  onAdd?: () => void;
  /** Clears the draft's filter and search. */
  onReset?: () => void;
  className?: string;
}

/**
 * What a view shows with no record in it (COL-9): "No clients yet" with New client, or, when the view's
 * filter or search is why, "No clients match these filters" with Reset. A filtered view offers no New: a
 * record added there would not match and would seem to vanish.
 */
export function EmptyRecords({ table, filtered, onAdd, onReset, className }: EmptyRecordsProps) {
  const plural = pluralize(recordNoun(table));
  if (filtered) {
    return <EmptyState className={className} title={`No ${plural} match these filters`} action={onReset && <Button onClick={onReset}>Reset</Button>} />;
  }
  return (
    <EmptyState
      className={className}
      title={`No ${plural} yet`}
      action={
        onAdd && (
          <Button variant="primary" onClick={onAdd}>
            <Plus aria-hidden className="size-4" /> {newRecordLabel(table)}
          </Button>
        )
      }
    />
  );
}
