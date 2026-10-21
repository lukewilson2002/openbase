/**
 * Sanitized markdown for rich-text fields: `marked` renders, DOMPurify sanitizes (no
 * scripts, no inline event handlers, links forced to open safely). The HTML never reaches the
 * DOM unsanitized, and only http(s)/mailto/tel links and relative anchors survive.
 *
 * It shows what the rich text editor (components/richtext) edits, with the same look (`ob-prose`
 * in styles/index.css): tables, numbered lists that keep their start number, task lists, and
 * GitHub alert callouts (`> [!WARNING]`), which marked renders as plain quotes.
 *
 * Images are only ever our own files (`/api/attachments/...`, see lib/media.ts): shown as an image,
 * video, audio player or file card in a `<figure>` with its caption, as blocks of their own. Every
 * other image is an ordinary link and is never fetched, whatever the text (or raw HTML in it) says.
 * Media only comes from Markdown image syntax written out plainly: raw HTML in the text never gets an
 * `<img>`, `<video>` or `<audio>` (even one that spells our address in disguise, as `&#47;api...`), and
 * neither does an address that only becomes ours after Markdown unescapes it (`/api\/attachments/...`).
 * On a shared page (ShareContext) the embeds carry the share token, or, for a link with a password,
 * are loaded with it (public/view/ShareEmbeds.ts).
 *
 * Mentions (`@[Name](usrXXXX)`, record/mentions.ts) show as chips (`.ob-mention`), as in the editor.
 */
import { useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { cn } from "@/lib/cn";
import { MENTION_AT_START } from "./mentions";
import { embedFilename, embedPreviewSrc, isEmbedSrc, mediaKind, mediaLabel, withShare } from "@/lib/media";
import { useShareOrNull } from "@/public/view/ShareContext";
import { protectedDownload, useProtectedEmbeds } from "@/public/view/ShareEmbeds";

let hooked = false;

/** The elements that fetch a file by themselves: they may only be given one of our own. */
const FETCHING = new Set(["IMG", "VIDEO", "AUDIO"]);

/** Marks the elements our own image renderer made, so the ones that came from raw HTML can be told apart. */
const MARK = "data-ob-media";

/**
 * A secret of the render in progress: raw HTML in the text cannot know it, so an element carrying it was
 * made by the renderer and nothing else was.
 */
let nonce = "";

function newNonce(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
    if (FETCHING.has(node.tagName)) {
      // Only Markdown image syntax makes media (the renderer marked its own with the nonce), and only
      // of our own files: nothing is fetched from anywhere else, and raw HTML fetches nothing.
      const mine = nonce !== "" && node.getAttribute(MARK) === nonce;
      node.removeAttribute(MARK);
      const src = node.getAttribute("src") ?? node.getAttribute("data-embed");
      if (!mine || !isEmbedSrc(src?.split("?")[0])) node.parentNode?.removeChild(node);
    }
  });
}

/** Where the render in progress is (marked's renderer has no way to be handed options). */
interface Embeds {
  token: string;
  /** The link has a password, so the bytes are fetched with it (ShareEmbeds.ts). */
  password: boolean;
}
let embeds: Embeds | null = null;

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const CALLOUT = /^\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s|<br\s*\/?>)*/i;

// Only the pieces that differ from marked's own HTML: alert callouts, and task-list boxes (an
// <input> would not survive the sanitizer below, so the box is a span with the checkbox role).
const renderer = new marked.Renderer();
renderer.blockquote = (quote: string) => {
  const m = CALLOUT.exec(quote);
  if (!m) return `<blockquote>\n${quote}</blockquote>\n`;
  const rest = quote.slice(m[0].length);
  // Text after the marker stays in the first paragraph; with none, that paragraph is gone.
  const body = /^<\/p>/.test(rest) ? rest.replace(/^<\/p>\s*/, "") : `<p>${rest}`;
  return `<div class="ob-callout" data-callout="${m[1]!.toLowerCase()}">\n${body}</div>\n`;
};

// An image is one of our files, as a block (`<figure>`), or a link. `text` and `title` come escaped from marked.
renderer.image = (href: string, title: string | null, text: string) => {
  if (!isEmbedSrc(href)) {
    const label = text.trim() || (href.startsWith("data:") ? "image" : esc(href));
    return `<a href="${esc(href)}"${title ? ` title="${title}"` : ""}>${label}</a>`;
  }
  const filename = embedFilename(href);
  const kind = mediaKind(filename);
  const name = esc(mediaLabel(href, ""));
  // Open shares authorise by token in the address; protected ones get their bytes through ShareEmbeds.
  const address = embeds && !embeds.password ? withShare(href, embeds.token) : href;
  const where = `${MARK}="${nonce}" ${embeds?.password ? `data-embed="${esc(href)}"` : `src="${esc(address)}"`}`;
  const label = text.trim() || name;
  let body: string;
  if (kind === "image") body = `<img ${where} alt="${text}" loading="lazy">`;
  else if (kind === "video") body = `<video ${where} controls playsinline preload="metadata" aria-label="${label}"></video>`;
  else if (kind === "audio") body = `<audio ${where} controls preload="metadata" aria-label="${label}"></audio>`;
  else {
    const link = embeds?.password ? `href="${esc(address)}" data-embed="${esc(href)}"` : `href="${esc(address)}"`;
    // A PDF shows its first page over the file icon; a preview that fails to load (alt "") leaves the icon.
    const preview = embedPreviewSrc(embeds?.password ? href : address);
    const thumb = preview ? `<img ${MARK}="${nonce}" ${embeds?.password ? `data-embed="${esc(preview)}"` : `src="${esc(preview)}"`} alt="" loading="lazy">` : "";
    body = `<div class="ob-file"><span class="ob-file-icon" aria-hidden="true">${thumb}</span><span class="ob-file-name">${name}</span><a ${link} download="${name}" class="ob-file-download">Download</a></div>`;
  }
  return `<figure class="ob-media" data-kind="${kind}">${body}${title ? `<figcaption>${title}</figcaption>` : ""}</figure>`;
};
// A figure is a block: lifted out of the paragraph it was written in, the text around it staying paragraphs.
const FIGURE = /(<figure class="ob-media"[\s\S]*?<\/figure>)/;
renderer.paragraph = (text: string) => {
  if (!text.includes('<figure class="ob-media"')) return `<p>${text}</p>\n`;
  return text
    .split(FIGURE)
    .map((piece) => {
      if (piece.startsWith('<figure class="ob-media"')) return `${piece}\n`;
      const rest = piece.replace(/^(?:\s|<br\s*\/?>)+|(?:\s|<br\s*\/?>)+$/gi, "");
      return rest ? `<p>${rest}</p>\n` : "";
    })
    .join("");
};
renderer.checkbox = (checked: boolean) => `<span class="ob-check" role="checkbox" aria-checked="${checked}" aria-disabled="true"></span> `;

// A mention is read before links (extensions come first), so `@[Name](usr…)` never becomes a link.
marked.use({
  extensions: [
    {
      name: "mention",
      level: "inline",
      start: (src: string) => {
        const at = src.indexOf("@[");
        return at < 0 ? undefined : at;
      },
      tokenizer: (src: string) => {
        const m = MENTION_AT_START.exec(src);
        return m ? { type: "mention", raw: m[0], label: m[1]!, id: m[2]! } : undefined;
      },
      renderer: (token) => `<span class="ob-mention" data-mention="${esc(String(token.id))}">@${esc(String(token.label))}</span>`,
    },
  ],
});

/**
 * An image whose address is ours only after Markdown has unescaped it (`/api\\/attachments/...`) is no
 * embed: it becomes a link, like any other address that is not written out plainly.
 */
function plainEmbeds(found: marked.Token): void {
  const token = found as unknown as { type: string; href: string; raw?: string; text: string; tokens?: unknown[] };
  if (token.type !== "image" || !isEmbedSrc(token.href)) return;
  const raw = token.raw ?? "";
  // Written inline, the address must appear in the text just as it is (a reference-style image has
  // its address elsewhere; the server checks that text for the same references).
  if (!/\]\(/.test(raw) || raw.includes(token.href)) return;
  const label = token.text.trim() || esc(token.href);
  token.type = "link";
  token.tokens = [{ type: "text", raw: label, text: label }];
}

/**
 * Render markdown to sanitized HTML. `share` is given on a shared page, where the embedded files
 * are authorised by the share's token.
 */
export function renderMarkdown(source: string, share?: Embeds | null): string {
  ensureHooks();
  embeds = share ?? null;
  nonce = newNonce();
  let html: string;
  try {
    html = marked.parse(source, { gfm: true, breaks: true, mangle: false, headerIds: false, renderer, walkTokens: plainEmbeds });
    return sanitize(html);
  } finally {
    embeds = null;
    nonce = "";
  }
}

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "source", "track"],
    FORBID_ATTR: ["style", "srcset", "poster"],
    // DOMPurify drops `start` by default, which would restart "5." at 1. Its value is a number, not a
    // URL, so it also has to be exempt from the URI check above, as are the other attributes of the
    // embeds whose values are words (`lazy`, `metadata`, a file name).
    ADD_ATTR: ["start"],
    ADD_URI_SAFE_ATTR: ["start", "download", "loading", "preload"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/(?!\/))/i,
  });
}

// Block ends and line breaks become spaces so "# Plan" + "Buy milk" reads "Plan Buy milk", not "PlanBuy milk".
const BLOCK_END = /<(?:br|hr|\/(?:p|h[1-6]|li|td|th|tr|blockquote|pre|div))\b[^>]*>/gi;

/**
 * The words of a markdown text without its markup, for previews. It goes through the same sanitizer
 * as rendered markdown and is parsed with DOMParser, whose documents never run scripts or fetch
 * images, so entities decode and inline HTML drops away without touching the page.
 */
export function markdownToText(source: string): string {
  const html = renderMarkdown(source).replace(BLOCK_END, "$& ");
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const share = useShareOrNull();
  const token = share?.token;
  const protectedShare = share ? share.password !== null : false;
  const html = useMemo(() => renderMarkdown(source, token === undefined ? null : { token, password: protectedShare }), [source, token, protectedShare]);
  const ref = useRef<HTMLDivElement>(null);
  useProtectedEmbeds(ref, html, share);
  return (
    <div
      ref={ref}
      onClick={protectedShare ? (e) => protectedDownload(e, share) : undefined}
      className={cn("ob-markdown ob-prose text-[0.8125rem] leading-relaxed", className)}
      // Sanitized by DOMPurify in renderMarkdown.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
