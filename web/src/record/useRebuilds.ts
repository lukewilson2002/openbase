/**
 * When an editor that saves while it is typed in has to be built again because the value changed under it.
 *
 * Long text saves as it is typed, so the value that comes back is mostly our own save arriving, which must not
 * rebuild the editor: the caret would jump out from under the typing. A value is someone else's (or a refusal
 * rolling back) when it is not what we last saved, and it is not rebuilt in over text of ours that is typed but not
 * sent, or sent but not answered: a refetch in that time answers with what the server held before, and the next
 * keystroke would save that stale text. The count goes into the editor's `key`.
 */
import { useRef, type RefObject } from "react";
import { jsonEqual } from "@/lib/cells/parse";
import type { Unsent } from "./useRecordSave";

export function useRebuilds(textKey: string, value: unknown, lastSaved: RefObject<Map<string, unknown>>, unsent: RefObject<Unsent>, enabled = true): number {
  const rebuilds = useRef({ json: JSON.stringify(value), n: 0 });
  if (enabled) {
    const json = JSON.stringify(value);
    if (json !== rebuilds.current.json) {
      rebuilds.current.json = json;
      if (!jsonEqual(value, lastSaved.current.get(textKey) ?? null) && !unsent.current.isWaiting(textKey)) rebuilds.current.n++;
    }
  }
  return rebuilds.current.n;
}
