/**
 * Which files the server makes a preview of (`GET /api/attachments/{id}/thumb`, see the server's
 * `previews.rs`): an image is shown itself, a PDF by its first page, a video by its first frame.
 * The server decides from the file's bytes and answers 404 when it has none (a broken file, or a
 * video on a server without ffmpeg), so every tile falls back to the file-type tile on error.
 */
import type { AttachmentRef } from "@/api/types";

const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/ogg"]);

export function isPdf(file: Pick<AttachmentRef, "mime">): boolean {
  return file.mime === "application/pdf";
}

export function isVideo(file: Pick<AttachmentRef, "mime">): boolean {
  return VIDEO_MIMES.has(file.mime);
}

/** Whether the server may have a preview of `file`. */
export function hasPreview(file: Pick<AttachmentRef, "mime">): boolean {
  return file.mime.startsWith("image/") || isPdf(file) || isVideo(file);
}

/**
 * How a preview fills a square tile: cropped to the middle, except a page, which keeps its top
 * (a document's title and first lines say more than its middle).
 */
export function previewAlignTop(file: Pick<AttachmentRef, "mime">): boolean {
  return isPdf(file);
}

/** Extension label of the file-type tile ("PDF"), up to four letters, or "FILE". */
export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1, i + 5).toUpperCase() : "FILE";
}

/** The file a card's cover shows: its first image, else its first file with a preview (a PDF, a video). */
export function coverFile<T extends Pick<AttachmentRef, "mime">>(files: readonly T[]): T | undefined {
  return files.find((f) => f.mime.startsWith("image/")) ?? files.find(hasPreview);
}
