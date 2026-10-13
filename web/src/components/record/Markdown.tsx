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

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className={cn(
        "og-markdown text-[0.8125rem] leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-subtle [&_code]:px-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_img]:max-w-full [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-subtle [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5",
        className,
      )}
      // Sanitized by DOMPurify in renderMarkdown.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
