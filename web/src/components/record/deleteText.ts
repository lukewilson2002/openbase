import { atLeast } from "@/lib/roles";
import { daysText } from "@/components/trash/retention";
import { DEFAULT_RETENTION_DAYS } from "@/components/trash/trashItem";

/**
 * What a "delete records?" confirmation says about getting them back, true for the person's role:
 * deleted records go to the project's trash for `trashDays` days (the server's retention, APP-16). A Creator
 * restores any of them from there; an Editor sees and restores the records they deleted themselves (and not
 * those of others). Undo right after (the toast, or Ctrl/Cmd+Z) works for both. `name` is the record's title,
 * which names the one being deleted.
 */
export function deleteRecordsText(role: string, count = 1, trashDays = DEFAULT_RETENTION_DAYS, name?: string): { title: string; description: string } {
  const one = count === 1;
  const title = one ? (name?.trim() ? `Delete “${name.trim()}”?` : "Delete this record?") : `Delete ${count.toLocaleString()} records?`;
  const them = one ? "it" : "them";
  const span = `${one ? "It moves" : "They move"} to the trash for ${daysText(trashDays)}.`;
  const description = atLeast(role, "creator")
    ? `${span} Restore ${them} from Trash until then, or press Undo right after.`
    : `${span} Press Undo right after, or restore ${them} later from Trash: editors can restore the records they deleted themselves.`;
  return { title, description };
}
