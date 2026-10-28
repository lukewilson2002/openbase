import { atLeast } from "@/lib/roles";

/**
 * What a "delete records?" confirmation says about getting them back, true for the person's role:
 * deleted records go to the project's trash. A Creator restores any of them from there; an Editor
 * sees and restores the records they deleted themselves (and not those of others). Undo right after
 * (the toast, or Ctrl/Cmd+Z) works for both.
 */
export function deleteRecordsText(role: string, count = 1): { title: string; description: string } {
  const one = count === 1;
  const title = one ? "Delete this record?" : `Delete ${count.toLocaleString()} records?`;
  const them = one ? "it" : "them";
  const description = atLeast(role, "creator")
    ? `${one ? "It moves" : "They move"} to the trash. You can restore ${them} from there, or press Undo right after.`
    : `${one ? "It moves" : "They move"} to the trash. Press Undo right after, or restore ${them} later from the trash: editors can restore the records they deleted themselves.`;
  return { title, description };
}
