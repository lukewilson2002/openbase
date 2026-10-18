/**
 * The callout block: a quote with a kind, stored as GitHub alert syntax so a value stays readable
 * as plain Markdown (and on GitHub):
 *
 *     > [!WARNING]
 *     > Back up first.
 *
 * Markdown has one token for both, so `QuoteOrCallout` (Tiptap's Blockquote with a different
 * `parseMarkdown`) decides on `[!KIND]` in the first line; `Callout` only renders.
 */
import { Node, mergeAttributes, wrappingInputRule } from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";

export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export const CALLOUT_LABELS: Record<CalloutKind, string> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the selection in a callout, or change the kind of the callout it is in. */
      setCallout: (kind: CalloutKind) => ReturnType;
      unsetCallout: () => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: "note" as CalloutKind,
        parseHTML: (el) => (el.getAttribute("data-callout") as CalloutKind | null) ?? "note",
        renderHTML: (attrs) => ({ "data-callout": attrs.kind as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "ob-callout" }), 0];
  },

  renderMarkdown: (node, h) => {
    const kind = String(node.attrs?.kind ?? "note").toUpperCase();
    const body = (node.content ?? []).map((child, i) => h.renderChild?.(child, i) ?? h.renderChildren([child]));
    const lines = [`> [!${kind}]`];
    body.forEach((block, i) => {
      if (i > 0) lines.push(">");
      for (const line of block.split("\n")) lines.push(line.trim() === "" ? ">" : `> ${line}`);
    });
    return lines.join("\n");
  },

  addCommands() {
    return {
      setCallout:
        (kind) =>
        ({ commands, editor }) =>
          editor.isActive(this.name) ? commands.updateAttributes(this.name, { kind }) : commands.wrapIn(this.name, { kind }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },

  addInputRules() {
    // `[!NOTE] ` at the start of a line wraps it, so the syntax works when typed as well.
    return [wrappingInputRule({ find: /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s$/i, type: this.type, getAttributes: (m) => ({ kind: m[1]!.toLowerCase() }) })];
  },
});

/** The quote block, reading `> [!KIND]` as a callout. Use in place of StarterKit's blockquote. */
export const QuoteOrCallout = Blockquote.extend({
  parseMarkdown: (token, helpers) => {
    const tokens = (token.tokens ?? []) as { type: string; text?: string }[];
    const first = tokens[0];
    const m = first?.type === "paragraph" ? MARKER.exec(first.text ?? "") : null;
    if (!first || !m) {
      const parseBlocks = (helpers.parseBlockChildren ?? helpers.parseChildren) as (tokens: unknown[]) => unknown[];
      return helpers.createNode("blockquote", undefined, parseBlocks(token.tokens ?? []) as never);
    }
    const rest = (first.text ?? "").slice(m[0].length);
    const content: unknown[] = [];
    if (rest.trim()) content.push({ type: "paragraph", content: helpers.tokenizeInline ? helpers.parseInline(helpers.tokenizeInline(rest)) : [{ type: "text", text: rest }] });
    content.push(...helpers.parseChildren(tokens.slice(1) as never));
    if (content.length === 0) content.push({ type: "paragraph" });
    return { type: "callout", attrs: { kind: m[1]!.toLowerCase() as CalloutKind }, content } as never;
  },
});
