/**
 * Media embeds in rich text. An embed is Markdown image syntax whose address is one of our own
 * files (`![Alt](/api/attachments/{id}/{file name} "Caption")`); nothing else is shown as media.
 * The rich text editor and the read-only renderer both decide with the functions here, so what is
 * editable as a block is exactly what is displayed as one.
 */

/** Where the files of the instance are served from. */
export const EMBED_PREFIX = "/api/attachments/";

/** `/api/attachments/{id}/{url-encoded file name}`: no host, no query, no further path. */
const EMBED_SRC = /^\/api\/attachments\/[\w-]+\/[^/?#\\\s]+$/;

export type MediaKind = "image" | "video" | "audio" | "file";

const IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);
const VIDEO = new Set(["mp4", "m4v", "webm", "mov"]);
const AUDIO = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"]);

/** Whether `src` is the address of one of our files (and so may be embedded). */
export function isEmbedSrc(src: unknown): boolean {
  if (typeof src !== "string" || !EMBED_SRC.test(src)) return false;
  const name = src.slice(src.lastIndexOf("/") + 1);
  return name !== "." && name !== "..";
}

/** The file name an embed address names, decoded. */
export function embedFilename(src: string): string {
  const raw = src.slice(src.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** How a file is shown, by the extension of its name. */
export function mediaKind(filename: string): MediaKind {
  const dot = filename.lastIndexOf(".");
  const ext = dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
  if (IMAGE.has(ext)) return "image";
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  return "file";
}

/** The embed address of an uploaded file. Parentheses are encoded too, so the Markdown stays unambiguous. */
export function embedSrc(id: string, filename: string): string {
  const name = encodeURIComponent(filename).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));
  return `${EMBED_PREFIX}${encodeURIComponent(id)}/${name}`;
}

/** The address of an embed on a public share page: the share token authorises it there. */
export function withShare(src: string, token: string): string {
  return `${src}?share=${encodeURIComponent(token)}`;
}

/** What a block is called for people who cannot see it: its alt text, or its file name. */
export function mediaLabel(src: string, alt: string): string {
  return alt.trim() || embedFilename(src);
}

/**
 * The preview address of an embedded file that is shown as a file card but has a picture of its own:
 * a PDF's first page (see lib/filePreview.ts). Null for the rest. Keeps a `?share=` query.
 */
export function embedPreviewSrc(src: string): string | null {
  const [path, query] = src.split("?", 2) as [string, string | undefined];
  if (!/\.pdf$/i.test(embedFilename(path))) return null;
  const thumb = `${path.slice(0, path.lastIndexOf("/") + 1)}thumb`;
  return query === undefined ? thumb : `${thumb}?${query}`;
}
