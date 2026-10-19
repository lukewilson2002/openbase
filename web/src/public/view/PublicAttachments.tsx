/**
 * Attachments of a shared view. Images and downloads are authorised by the share itself
 * (`?share=<token>`), and by `X-Share-Password` when the link has a password. An `<img>` or an
 * `<a>` cannot send a header, so for protected links the bytes are fetched with the header and
 * shown from a blob URL (kept in memory only); open links use plain URLs.
 */
import { useEffect, useState } from "react";
import { publicApi } from "@/api/sharing";
import type { AttachmentRef } from "@/api/types";
import { FilePreview } from "@/components/record/FilePreview";
import { hasPreview } from "@/lib/filePreview";
import { saveBlob } from "@/lib/download";
import { formatBytes } from "@/lib/format";
import { useShare } from "./ShareContext";

/** Blob URLs by attachment, shared by every cell of the page (a few thumbnails are reused a lot). */
const blobUrls = new Map<string, Promise<string>>();

function loadBlobUrl(token: string, password: string, file: AttachmentRef): Promise<string> {
  const key = `${token}|${file.id}`;
  let p = blobUrls.get(key);
  if (!p) {
    p = publicApi.attachmentBlob(token, file.id, null, password).then((r) => URL.createObjectURL(r.blob));
    blobUrls.set(key, p);
    // A failed fetch must not be remembered as the answer.
    p.catch(() => blobUrls.delete(key));
  }
  return p;
}

/** The `src` for a thumbnail: a plain URL for open links, a blob URL for password-protected ones. */
export function useThumbSrc(file: AttachmentRef | undefined): string | null {
  const { token, password } = useShare();
  const [blob, setBlob] = useState<{ key: string; url: string } | null>(null);
  const key = file ? `${token}|${file.id}|${password ?? ""}` : "";
  useEffect(() => {
    if (!file || password === null) return;
    let live = true;
    loadBlobUrl(token, password, file)
      .then((url) => live && setBlob({ key, url }))
      .catch(() => live && setBlob(null));
    return () => {
      live = false;
    };
  }, [file, token, password, key]);
  if (!file) return null;
  if (password === null) return publicApi.thumbUrl(token, file.id);
  return blob?.key === key ? blob.url : null;
}

/** A file's preview tile (see FilePreview) on a share page; the server answers 404 for a file without one. */
export function ShareThumb({ file, size = 40 }: { file: AttachmentRef; size?: number }) {
  const src = useThumbSrc(hasPreview(file) ? file : undefined);
  return <FilePreview file={file} src={src} size={size} />;
}

function FileLink({ file }: { file: AttachmentRef }) {
  const { token, password } = useShare();
  const [failed, setFailed] = useState(false);
  const label = (
    <>
      {file.filename}
      <span className="ml-1.5 text-xs text-muted">{formatBytes(file.size)}</span>
    </>
  );
  if (password === null) {
    return (
      <a href={publicApi.attachmentUrl(token, file.id, file.filename)} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-[0.8125rem]">
        {label}
      </a>
    );
  }
  return (
    <button
      type="button"
      className="min-w-0 truncate text-left text-[0.8125rem] text-primary underline-offset-2 hover:underline"
      onClick={() => {
        setFailed(false);
        publicApi
          .attachmentBlob(token, file.id, file.filename, password)
          .then((r) => saveBlob(r.blob, file.filename))
          .catch(() => setFailed(true));
      }}
    >
      {label}
      {failed && <span className="ml-1 text-xs text-danger">Could not download</span>}
    </button>
  );
}

/** Each file as its preview tile (or its type's), with a link that downloads it. */
export function PublicAttachments({ files, compact }: { files: readonly AttachmentRef[]; compact?: boolean }) {
  if (files.length === 0) return <span className="text-faint">—</span>;
  if (compact) {
    return (
      <ul className="flex flex-wrap gap-1.5">
        {files.map((f) => (
          <li key={f.id} title={f.filename}>
            <ShareThumb file={f} size={32} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-2">
          <ShareThumb file={f} size={36} />
          <FileLink file={f} />
        </li>
      ))}
    </ul>
  );
}
