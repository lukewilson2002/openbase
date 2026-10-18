/**
 * Sanitized markdown for rich long-text fields: `marked` renders, DOMPurify sanitizes (no
 * scripts, no inline event handlers, links forced to open safely). The HTML never reaches the
 * DOM unsanitized, and only http(s)/mailto/tel links and relative anchors survive.
 *
 * It shows what the rich text editor (components/richtext) edits, with the same look (`ob-prose`
 * in styles/index.css): tables, numbered lists that keep their start number, task lists, and
 * GitHub alert callouts (`> [!WARNING]`), which marked renders as plain quotes.
 */
import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { cn } from "@/lib/cn";

let hooked = false;

function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
}

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
renderer.checkbox = (checked: boolean) => `<span class="ob-check" role="checkbox" aria-checked="${checked}" aria-disabled="true"></span> `;

/** Render markdown to sanitized HTML. */
export function renderMarkdown(source: string): string {
  ensureHooks();
  const html = marked.parse(source, { gfm: true, breaks: true, mangle: false, headerIds: false, renderer });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "srcset"],
    // DOMPurify drops `start` by default, which would restart "5." at 1. Its value is a number, not a
    // URL, so it also has to be exempt from the URI check above.
    ADD_ATTR: ["start"],
    ADD_URI_SAFE_ATTR: ["start"],
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
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className={cn("ob-markdown ob-prose text-[0.8125rem] leading-relaxed", className)}
      // Sanitized by DOMPurify in renderMarkdown.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
