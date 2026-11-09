import { useSetupStatus } from "@/auth/useAuth";
import { DEFAULT_RETENTION_DAYS } from "./trashItem";

/**
 * Days the server keeps deleted things (`OPENBASE_TRASH_DAYS`, published by `GET /api/setup`). The server's
 * default until the answer arrives, so a confirmation opened at once never says nothing.
 */
export function useTrashDays(): number {
  const { data } = useSetupStatus();
  return data?.trash_days ?? DEFAULT_RETENTION_DAYS;
}

export function daysText(days: number): string {
  return days === 1 ? "1 day" : `${days.toLocaleString()} days`;
}

/**
 * The sentence every deletion that can be undone ends with (APP-16): "The folder moves to the trash for 30 days.
 * Restore it from Trash until then." `what` is the subject, `plural` picks the verb.
 */
export function movesToTrash(days: number, what = "It", plural = false): string {
  return `${what} ${plural ? "move" : "moves"} to the trash for ${daysText(days)}. Restore ${plural ? "them" : "it"} from Trash until then.`;
}
