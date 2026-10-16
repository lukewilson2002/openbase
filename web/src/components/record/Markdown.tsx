/**
 * Sanitized markdown for rich long-text fields: `marked` renders, DOMPurify sanitizes (no
 * scripts, no inline event handlers, links forced to open safely). The HTML never reaches the
 * DOM unsanitized, and only http(s)/mailto/tel links and relative anchors survive.
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

/** Render markdown to sanitized HTML. */
export function renderMarkdown(source: string): string {
  ensureHooks();
  const html = marked.parse(source, { gfm: true, breaks: true, mangle: false, headerIds: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "srcset"],
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
      className={cn(
        "ob-markdown text-[0.8125rem] leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-subtle [&_code]:px-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_img]:max-w-full [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-subtle [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5",
        className,
      )}
      // Sanitized by DOMPurify in renderMarkdown.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
