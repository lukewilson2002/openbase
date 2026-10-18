/**
 * Uploading files into the open draft (`POST /api/inbox/attachments`): one after the other, each
 * landing in the draft as soon as it is up (and saved with it), failures named in plain words. A
 * file belongs to the draft it was started in: if another draft (or a blank one) is open when it
 * arrives, it is left out (the server keeps an unreferenced upload for a while, then removes it).
 */
import { useCallback, useRef, useState } from "react";
import { ApiError, errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import type { AttachmentRef } from "@/api/types";

/** A draft holds at most this many files (the server's limit). */
export const MAX_DRAFT_FILES = 20;

/** What went wrong with an upload, for a person rather than a status code. */
export function uploadProblem(name: string, e: unknown): string {
  if (e instanceof ApiError && e.status === 413) {
    return `${name}: no room for this file. Either it is too large, or the files waiting in your inbox have reached their limit. File or discard a draft to make room.`;
  }
  if (e instanceof ApiError && e.status === 429) return `${name}: too many uploads in a short time. Wait a minute and try again.`;
  return `${name}: ${errorMessage(e)}`;
}

function leftOut(name: string): string {
  return `${name}: not added, because another draft was opened while it was uploading. Attach it again where you want it.`;
}

export interface Uploads {
  /** Names of the files going up right now. */
  uploading: string[];
  errors: string[];
  upload(files: readonly File[]): Promise<void>;
  dismissErrors(): void;
}

/** `draftKey` is the open draft's (it changes whenever another draft is loaded). */
export function useUploads(held: number, onUploaded: (ref: AttachmentRef) => void, draftKey: number): Uploads {
  const [uploading, setUploading] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const openKey = useRef(draftKey);
  openKey.current = draftKey;

  const upload = useCallback(
    async (files: readonly File[]) => {
      setErrors([]);
      const room = Math.max(0, MAX_DRAFT_FILES - held - uploading.length);
      const take = files.slice(0, room);
      if (take.length < files.length) {
        setErrors([`A draft holds at most ${MAX_DRAFT_FILES} files. ${files.length - take.length} not added.`]);
      }
      const startedIn = draftKey;
      for (const file of take) {
        if (openKey.current !== startedIn) {
          setErrors((cur) => [...cur, leftOut(file.name)]);
          continue;
        }
        setUploading((cur) => [...cur, file.name]);
        try {
          const uploaded = await api.inbox.upload(file);
          if (openKey.current === startedIn) onUploaded(uploaded);
          else setErrors((cur) => [...cur, leftOut(file.name)]);
        } catch (e) {
          setErrors((cur) => [...cur, uploadProblem(file.name, e)]);
        } finally {
          setUploading((cur) => {
            const at = cur.indexOf(file.name);
            return at < 0 ? cur : [...cur.slice(0, at), ...cur.slice(at + 1)];
          });
        }
      }
    },
    [draftKey, held, onUploaded, uploading.length],
  );

  const dismissErrors = useCallback(() => setErrors([]), []);
  return { uploading, errors, upload, dismissErrors };
}
