/**
 * Files embedded in rich text on a shared page, for links with a password. An `<img>`, `<video>` or
 * download link cannot send `X-Share-Password`, so Markdown.tsx renders such an embed without an
 * address (it carries `data-embed`) and this fetches it with the header, showing it from a blob URL
 * (kept in memory only). Open links need none of this: their embeds carry `?share=<token>`.
 */
import { useEffect, type MouseEvent, type RefObject } from "react";
import { publicApi } from "@/api/sharing";
import { saveBlob } from "@/lib/download";
import { embedFilename, isEmbedSrc } from "@/lib/media";

/** Blob URLs by share and address, so an embed shown twice (or after an edit of the text) is fetched once. */
const blobUrls = new Map<string, Promise<string>>();

function fileOf(src: string): { id: string; filename: string } {
  return { id: src.split("/")[3]!, filename: embedFilename(src) };
}

function loadEmbed(token: string, password: string, src: string): Promise<string> {
  const key = `${token}|${password}|${src}`;
  let p = blobUrls.get(key);
  if (!p) {
    const { id, filename } = fileOf(src);
    p = publicApi.attachmentBlob(token, id, filename, password).then((r) => URL.createObjectURL(r.blob));
    blobUrls.set(key, p);
    // A failed fetch must not be remembered as the answer.
    p.catch(() => blobUrls.delete(key));
  }
  return p;
}

/** Gives the images, videos and audio of a rendered text their bytes. A no-op without `password`. */
export function useProtectedEmbeds(root: RefObject<HTMLElement | null>, html: string, share: { token: string; password: string | null } | null): void {
  const token = share?.token;
  const password = share?.password ?? null;
  useEffect(() => {
    const el = root.current;
    if (!el || token === undefined || password === null) return;
    let live = true;
    el.querySelectorAll<HTMLElement>("figure.ob-media img[data-embed], figure.ob-media video[data-embed], figure.ob-media audio[data-embed]").forEach((media) => {
      const src = media.getAttribute("data-embed");
      if (!isEmbedSrc(src)) return;
      loadEmbed(token, password, src!)
        .then((url) => live && media.setAttribute("src", url))
        .catch(() => {});
    });
    return () => {
      live = false;
    };
  }, [root, html, token, password]);
}

/** The click on a download link of a protected share: fetch the file with the password and save it. */
export function protectedDownload(e: MouseEvent, share: { token: string; password: string | null } | null): void {
  if (!share || share.password === null) return;
  const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("figure.ob-media a[data-embed]");
  const src = link?.getAttribute("data-embed");
  if (!link || !isEmbedSrc(src)) return;
  e.preventDefault();
  const { id, filename } = fileOf(src!);
  publicApi
    .attachmentBlob(share.token, id, filename, share.password)
    .then((r) => saveBlob(r.blob, filename))
    .catch(() => {});
}
