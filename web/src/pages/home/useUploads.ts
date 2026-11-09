/**
 * Files pasted or dropped on the capture box (HOME-3): each goes up to where the capture will land (a folder's attachments,
 * or the Inbox's files) as soon as it is chosen and waits as a chip until the capture is added. A file belongs to the place it
 * was uploaded for: when "Goes to" changes the files are let go (the server clears an unreferenced upload after a while) and
 * the person is told, rather than a file quietly ending up somewhere else.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorMessage } from "@/api/client";
import type { AttachmentRef } from "@/api/types";

/** A draft holds at most this many files (the server's limit). */
export const MAX_DRAFT_FILES = 20;

/** What went wrong with an upload, for a person rather than a status code. */
export function uploadProblem(name: string, e: unknown): string {
  if (e instanceof ApiError && e.status === 413) {
    return `${name}: no room for this file. Either it is too large, or the files waiting in your inbox have reached their limit. File or delete a draft to make room.`;
  }
  if (e instanceof ApiError && e.status === 429) return `${name}: too many uploads in a short time. Wait a minute and try again.`;
  return `${name}: ${errorMessage(e)}`;
}

export interface Uploads {
  files: AttachmentRef[];
  /** Names of the files going up right now. */
  uploading: string[];
  errors: string[];
  upload(files: readonly File[]): Promise<void>;
  remove(id: string): void;
  /** Forget the files after they were used. */
  clear(): void;
  /** Say why files cannot be taken (the place has nowhere to keep them). */
  refuse(message: string): void;
  dismissErrors(): void;
}

/** `scope` names where the files will land; `send` uploads one file there; `initial` is what is already attached (a draft being edited). */
export function useUploads(scope: string, send: (file: File) => Promise<AttachmentRef>, max = MAX_DRAFT_FILES, initial: readonly AttachmentRef[] = []): Uploads {
  const [files, setFiles] = useState<AttachmentRef[]>(() => [...initial]);
  const [uploading, setUploading] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const scopeRef = useRef(scope);
  const sendRef = useRef(send);
  sendRef.current = send;
  const keptRef = useRef(0);
  keptRef.current = files.length;
  const heldRef = useRef(0);
  heldRef.current = files.length + uploading.length;

  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    if (keptRef.current === 0) return;
    setFiles([]);
    setErrors(["The files were let go because Goes to changed. Attach them again."]);
  }, [scope]);

  const upload = useCallback(
    async (list: readonly File[]) => {
      setErrors([]);
      const take = list.slice(0, Math.max(0, max - heldRef.current));
      if (take.length < list.length) setErrors([`A capture holds at most ${max} files. ${list.length - take.length} not added.`]);
      const startedIn = scopeRef.current;
      for (const file of take) {
        setUploading((cur) => [...cur, file.name]);
        try {
          const uploaded = await sendRef.current(file);
          if (scopeRef.current === startedIn) setFiles((cur) => [...cur, uploaded]);
          else setErrors((cur) => [...cur, `${file.name}: not added, because Goes to changed while it was uploading. Attach it again.`]);
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
    [max],
  );

  return {
    files,
    uploading,
    errors,
    upload,
    remove: useCallback((id: string) => setFiles((cur) => cur.filter((f) => f.id !== id)), []),
    clear: useCallback(() => setFiles([]), []),
    refuse: useCallback((message: string) => setErrors([message]), []),
    dismissErrors: useCallback(() => setErrors([]), []),
  };
}
