/**
 * The Inbox's open draft and how it is kept. The first time there is something in the box (text or a
 * file) a draft is created; after that every change is saved with a PATCH once typing pauses
 * (`DRAFT_SAVE_MS`), when focus leaves the box, when the page goes to the background and when the
 * page is left. Saves run one after another, so a slow one cannot land after a later one, and the
 * draft list in the cache follows each answer. Clearing the box keeps the draft (it is just empty);
 * only `discard` deletes it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage, isApiError } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { AttachmentRef, InboxItem } from "@/api/types";
import { isBlank } from "./targets";

/** How long typing pauses before the draft is saved. */
export const DRAFT_SAVE_MS = 700;

export type DraftStatus = "idle" | "saving" | "saved" | "error";

interface Doc {
  /** The draft's id once it exists on the server. */
  id: string | null;
  /** One line, may be empty: what the record's primary field will say. */
  title: string;
  body: string;
  attachments: AttachmentRef[];
  /** Changes whenever another draft (or a blank one) is loaded, so the editor is rebuilt around it. */
  key: number;
}

export interface Draft extends Doc {
  status: DraftStatus;
  error: string | null;
  setTitle(title: string): void;
  setBody(md: string): void;
  addAttachment(ref: AttachmentRef): void;
  removeAttachment(id: string): void;
  /** Saves now. With `force` a blank draft is created too (filing a record needs one). Answers the draft's id. */
  save(force?: boolean): Promise<string | null>;
  /**
   * Saves the open draft, then opens `item`, or a blank one. Answers whether it did: it does not when
   * `item` is the draft that is open already, nor when the text in the box could not be saved (the box
   * stays as it is, with its error, rather than losing the text).
   */
  open(item?: InboxItem): Promise<boolean>;
  /** Deletes the open draft (if it exists on the server) and starts a blank one. */
  discard(): Promise<void>;
  /** The draft has gone (it was filed): a blank one replaces it without saving anything. */
  reset(): void;
}

const BLANK: Doc = { id: null, title: "", body: "", attachments: [], key: 0 };
const EMPTY = { id: null, title: "", body: "", attachments: [] };

export function useDraft(): Draft {
  const qc = useQueryClient();
  const [doc, setDoc] = useState<Doc>(BLANK);
  const [status, setStatus] = useState<DraftStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // The latest of everything, readable from timers and from saves that outlive a render.
  const ref = useRef<Doc>(BLANK);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const update = useCallback((patch: Partial<Doc>) => {
    ref.current = { ...ref.current, ...patch };
    setDoc(ref.current);
  }, []);

  /** Puts the saved draft first in the list without refetching it. */
  const remember = useCallback(
    (item: InboxItem) => {
      qc.setQueryData<InboxItem[]>(keys.inbox, (list) => (list ? [item, ...list.filter((i) => i.id !== item.id)] : list));
      if (!qc.getQueryData(keys.inbox)) void qc.invalidateQueries({ queryKey: keys.inbox });
    },
    [qc],
  );

  const run = useCallback(
    async (force: boolean): Promise<string | null> => {
      const snap = ref.current;
      if (!dirty.current && (snap.id !== null || !force)) return snap.id;
      if (snap.id === null && isBlank(snap.title, snap.body, snap.attachments) && !force) {
        dirty.current = false;
        return null;
      }
      dirty.current = false;
      setStatus("saving");
      setError(null);
      try {
        let item: InboxItem;
        if (snap.id === null) {
          item = await api.inbox.create({ title: snap.title, body: snap.body, attachments: snap.attachments });
        } else {
          try {
            item = await api.inbox.update(snap.id, { title: snap.title, body: snap.body, attachments: snap.attachments });
          } catch (e) {
            // Deleted elsewhere (another tab, an agent): keep what is in the box as a new draft.
            if (!isApiError(e) || e.status !== 404) throw e;
            item = await api.inbox.create({ title: snap.title, body: snap.body, attachments: snap.attachments });
          }
        }
        // Still the same draft? (`open` waits for saves, so only a new draft's id can have moved on.)
        if (ref.current.key === snap.key) update({ id: item.id });
        remember(item);
        setStatus("saved");
        return item.id;
      } catch (e) {
        dirty.current = true;
        setStatus("error");
        setError(errorMessage(e));
        return snap.id;
      }
    },
    [remember, update],
  );

  const save = useCallback(
    (force = false) => {
      clearTimeout(timer.current);
      timer.current = undefined;
      const next = queue.current.then(() => run(force));
      queue.current = next.catch(() => null);
      return next;
    },
    [run],
  );

  const changed = useCallback(
    (patch: Partial<Doc>, now = false) => {
      update(patch);
      dirty.current = true;
      setStatus("saving");
      if (now) void save();
      else {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void save(), DRAFT_SAVE_MS);
      }
    },
    [save, update],
  );

  const setTitle = useCallback(
    (title: string) => {
      if (title === ref.current.title) return;
      changed({ title });
    },
    [changed],
  );
  const setBody = useCallback(
    (body: string) => {
      // The editor reports its own echo of a document it was given: nothing changed.
      if (body === ref.current.body) return;
      changed({ body });
    },
    [changed],
  );
  const addAttachment = useCallback((a: AttachmentRef) => changed({ attachments: [...ref.current.attachments.filter((x) => x.id !== a.id), a] }, true), [changed]);
  const removeAttachment = useCallback((id: string) => changed({ attachments: ref.current.attachments.filter((a) => a.id !== id) }, true), [changed]);

  const load = useCallback(
    (next: Pick<Doc, "id" | "title" | "body" | "attachments">) => {
      clearTimeout(timer.current);
      dirty.current = false;
      update({ ...next, key: ref.current.key + 1 });
      setStatus(next.id ? "saved" : "idle");
      setError(null);
    },
    [update],
  );

  const open = useCallback(
    async (item?: InboxItem) => {
      // The row is the draft as the list last rendered it, which is older than the box.
      if (item && item.id === ref.current.id) return false;
      await save();
      // Whatever is still unsaved (the save failed) would be lost by loading something else.
      if (dirty.current) return false;
      // The freshest copy there is: the list may have moved on while the save ran.
      const fresh = item && qc.getQueryData<InboxItem[]>(keys.inbox)?.find((i) => i.id === item.id);
      const next = fresh ?? item;
      load(next ? { id: next.id, title: next.title, body: next.body, attachments: next.attachments } : EMPTY);
      return true;
    },
    [load, qc, save],
  );

  const discard = useCallback(async () => {
    clearTimeout(timer.current);
    dirty.current = false;
    // A save in flight may be creating the draft: wait for it to know the id.
    await queue.current;
    const id = ref.current.id;
    if (id) {
      await api.inbox.remove(id);
      qc.setQueryData<InboxItem[]>(keys.inbox, (list) => list?.filter((i) => i.id !== id));
    }
    load(EMPTY);
  }, [load, qc]);

  const reset = useCallback(() => load(EMPTY), [load]);

  // What is waiting is saved when the page goes to the background (a phone's tab switch may be the last
  // chance) and when the person leaves the Inbox.
  useEffect(() => {
    const flush = () => void save();
    const hidden = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [save]);

  return { ...doc, status, error, setTitle, setBody, addAttachment, removeAttachment, save, open, discard, reset };
}
